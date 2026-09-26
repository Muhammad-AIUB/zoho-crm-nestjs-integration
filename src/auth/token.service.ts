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

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly accountsUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  /** Shared promise so parallel requests trigger only one refresh call. */
  private refreshInFlight: Promise<string> | null = null;

  constructor(
    config: ConfigService,
    private readonly store: TokenStoreService,
  ) {
    this.accountsUrl = config.getOrThrow<string>('ZOHO_ACCOUNTS_URL');
    this.clientId = config.getOrThrow<string>('ZOHO_CLIENT_ID');
    this.clientSecret = config.getOrThrow<string>('ZOHO_CLIENT_SECRET');
    this.redirectUri = config.getOrThrow<string>('ZOHO_REDIRECT_URI');
  }

  /** Swap the one-time authorization code for access + refresh tokens. */
  async exchangeCode(code: string): Promise<StoredTokens> {
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
    await this.store.save(tokens);
    return tokens;
  }

  /** Returns a usable access token, refreshing it first if needed. */
  async getAccessToken(): Promise<string> {
    const tokens = await this.store.read();
    if (!tokens) {
      throw new ZohoApiError(
        HttpStatus.UNAUTHORIZED,
        'NOT_AUTHORIZED',
        'No Zoho tokens found. Visit /oauth/login to connect your Zoho account.',
        'local token store',
      );
    }

    if (Date.now() < tokens.expires_at - EXPIRY_BUFFER_MS) {
      return tokens.access_token;
    }
    return this.refreshAccessToken();
  }

  /** Forces a refresh. Also used when Zoho rejects a token we thought was valid. */
  async refreshAccessToken(): Promise<string> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.doRefresh().finally(() => {
        this.refreshInFlight = null;
      });
    }
    return this.refreshInFlight;
  }

  private async doRefresh(): Promise<string> {
    const current = await this.store.read();
    if (!current?.refresh_token) {
      throw new ZohoApiError(
        HttpStatus.UNAUTHORIZED,
        'NOT_AUTHORIZED',
        'No refresh token available. Visit /oauth/login to connect your Zoho account.',
        'local token store',
      );
    }

    this.logger.log('Access token expired, refreshing');
    const data = await this.requestToken({
      grant_type: 'refresh_token',
      refresh_token: current.refresh_token,
    });

    // Zoho does not send a new refresh token on refresh — keep the old one.
    const tokens = this.toStoredTokens(data, current.refresh_token);
    await this.store.save(tokens);
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
      const code = (data.error ?? 'UNKNOWN').toUpperCase();
      const unauthorized = [
        'INVALID_CODE',
        'INVALID_CLIENT',
        'INVALID_CLIENT_SECRET',
      ];
      throw new ZohoApiError(
        unauthorized.includes(code)
          ? HttpStatus.UNAUTHORIZED
          : HttpStatus.BAD_REQUEST,
        code,
        code === 'INVALID_CODE'
          ? 'The authorization code or refresh token is invalid or expired. Visit /oauth/login again.'
          : `Zoho rejected the token request (${code}).`,
        endpoint,
      );
    }

    return data;
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
