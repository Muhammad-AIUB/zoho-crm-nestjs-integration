import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ZohoApiError } from '../zoho/zoho-api.error';
import {
  StoredTokens,
  ZohoTokenResponse,
} from './interfaces/zoho-tokens.interface';
import { TokenStoreService } from './token-store.service';

/** Refresh a bit early so a token never expires mid-request. */
const EXPIRY_BUFFER_MS = 60_000;

/**
 * Zoho's API host for each data center (US, EU, IN, AU, JP, CN, CA, SA).
 * The access token is sent to this host, so only real Zoho hosts are used.
 */
const ZOHO_API_DOMAIN_PATTERN =
  /^https:\/\/www\.zohoapis\.(com|eu|in|com\.au|jp|com\.cn|ca|sa)$/;

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly accountsUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly defaultApiDomain: string;

  /**
   * One in-flight refresh per tenant: parallel requests for the same tenant
   * share a single refresh call, while different tenants never wait on each
   * other.
   */
  private readonly refreshInFlight = new Map<string, Promise<string>>();

  constructor(
    config: ConfigService,
    private readonly store: TokenStoreService,
  ) {
    this.accountsUrl = config.getOrThrow<string>('ZOHO_ACCOUNTS_URL');
    this.clientId = config.getOrThrow<string>('ZOHO_CLIENT_ID');
    this.clientSecret = config.getOrThrow<string>('ZOHO_CLIENT_SECRET');
    this.redirectUri = config.getOrThrow<string>('ZOHO_REDIRECT_URI');
    this.defaultApiDomain = config.getOrThrow<string>('ZOHO_API_DOMAIN');
  }

  /**
   * Each Zoho org lives in one data center, and the token response tells us
   * which (`api_domain`, e.g. https://www.zohoapis.eu). Using it per tenant
   * means an EU customer and a US customer can both be served by the same
   * app. Falls back to ZOHO_API_DOMAIN if it's missing or not a Zoho host.
   */
  async getApiDomain(tenantId: string): Promise<string> {
    const domain = (await this.store.read(tenantId))?.api_domain;
    if (domain && ZOHO_API_DOMAIN_PATTERN.test(domain)) return domain;
    if (domain) {
      this.logger.warn(
        `Ignoring unexpected api_domain for tenant "${tenantId}", using ${this.defaultApiDomain}`,
      );
    }
    return this.defaultApiDomain;
  }

  /** Swap the one-time authorization code for access + refresh tokens. */
  async exchangeCode(tenantId: string, code: string): Promise<StoredTokens> {
    const data = await this.requestToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
    });

    if (!data.refresh_token) {
      // Zoho only issues a refresh token with access_type=offline + prompt=consent.
      throw new ZohoApiError(
        HttpStatus.BAD_GATEWAY,
        'NO_REFRESH_TOKEN',
        'Zoho did not return a refresh token. Start the flow again from /oauth/login.',
        'POST /oauth/v2/token',
      );
    }

    const tokens = this.toStoredTokens(data, data.refresh_token);
    await this.store.save(tenantId, tokens);
    return tokens;
  }

  /** Returns a usable access token for the tenant, refreshing it if needed. */
  async getAccessToken(tenantId: string): Promise<string> {
    const tokens = await this.store.read(tenantId);
    if (!tokens) throw this.notConnected(tenantId);

    if (Date.now() < tokens.expires_at - EXPIRY_BUFFER_MS) {
      return tokens.access_token;
    }
    return this.refreshAccessToken(tenantId);
  }

  /**
   * Refreshes the access token. Pass `rejectedToken` when Zoho just answered
   * 401 for it: if another request already replaced that token, we reuse the
   * new one instead of refreshing again. Zoho only allows ~10 refreshes per
   * 10 minutes, so a burst of 401s must not turn into a burst of refreshes.
   */
  async refreshAccessToken(
    tenantId: string,
    rejectedToken?: string,
  ): Promise<string> {
    let inFlight = this.refreshInFlight.get(tenantId);
    if (!inFlight) {
      inFlight = this.doRefresh(tenantId, rejectedToken).finally(() => {
        this.refreshInFlight.delete(tenantId);
      });
      this.refreshInFlight.set(tenantId, inFlight);
    }
    return inFlight;
  }

  private notConnected(tenantId: string): ZohoApiError {
    return new ZohoApiError(
      HttpStatus.UNAUTHORIZED,
      'NOT_AUTHORIZED',
      `Tenant "${tenantId}" has not connected a Zoho account. Visit /oauth/login?tenant=${tenantId} to connect it.`,
      'local token store',
    );
  }

  private async doRefresh(
    tenantId: string,
    rejectedToken?: string,
  ): Promise<string> {
    const current = await this.store.read(tenantId);
    if (
      rejectedToken &&
      current &&
      current.access_token !== rejectedToken &&
      Date.now() < current.expires_at - EXPIRY_BUFFER_MS
    ) {
      return current.access_token;
    }
    if (!current?.refresh_token) throw this.notConnected(tenantId);

    this.logger.log(`Refreshing access token for tenant "${tenantId}"`);
    const data = await this.requestToken({
      grant_type: 'refresh_token',
      refresh_token: current.refresh_token,
    });

    // Zoho does not send a new refresh token on refresh, so keep the old one.
    const tokens = this.toStoredTokens(data, current.refresh_token);
    await this.store.save(tenantId, tokens);
    return tokens.access_token;
  }

  private async requestToken(
    params: Record<string, string>,
  ): Promise<ZohoTokenResponse> {
    const endpoint = 'POST /oauth/v2/token';
    const body = new URLSearchParams({
      ...params,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    let data: ZohoTokenResponse;
    try {
      const res = await axios.post<ZohoTokenResponse>(
        `${this.accountsUrl}/oauth/v2/token`,
        body.toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10_000,
        },
      );
      data = res.data;
    } catch (err) {
      // Deliberately not rethrowing the axios error: its config holds the client secret.
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      throw new ZohoApiError(
        HttpStatus.BAD_GATEWAY,
        'TOKEN_REQUEST_FAILED',
        `Could not reach Zoho accounts server${status ? ` (HTTP ${status})` : ''}.`,
        endpoint,
      );
    }

    // Zoho reports OAuth errors as HTTP 200 with { error: "..." }.
    if (data.error || !data.access_token) {
      // e.g. "invalid_code" -> INVALID_CODE, "Access Denied" -> ACCESS_DENIED
      const code = (data.error ?? 'UNKNOWN')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_');
      const [status, message] = this.describeTokenError(code);
      throw new ZohoApiError(status, code, message, endpoint);
    }

    return data;
  }

  private describeTokenError(code: string): [HttpStatus, string] {
    switch (code) {
      case 'INVALID_CODE':
        return [
          HttpStatus.UNAUTHORIZED,
          'The authorization code or refresh token is invalid or expired. Visit /oauth/login again.',
        ];
      case 'ACCESS_DENIED':
        // Zoho allows only ~10 access tokens per 10 minutes per refresh token.
        return [
          HttpStatus.TOO_MANY_REQUESTS,
          'Zoho is rate-limiting token requests. Please retry in a few minutes.',
        ];
      case 'INVALID_CLIENT':
      case 'INVALID_CLIENT_SECRET':
      case 'INVALID_REDIRECT_URI':
        // Server misconfiguration, not the caller's fault.
        return [
          HttpStatus.INTERNAL_SERVER_ERROR,
          "Zoho rejected this server's OAuth client settings. Check ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ZOHO_REDIRECT_URI.",
        ];
      default:
        return [
          HttpStatus.BAD_GATEWAY,
          `Zoho rejected the token request (${code}).`,
        ];
    }
  }

  private toStoredTokens(
    data: ZohoTokenResponse,
    refreshToken: string,
  ): StoredTokens {
    return {
      access_token: data.access_token as string,
      refresh_token: refreshToken,
      expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
      api_domain: data.api_domain,
      token_type: data.token_type,
    };
  }
}
