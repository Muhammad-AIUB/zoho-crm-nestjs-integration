import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance, AxiosResponse, Method } from 'axios';
import { TokenService } from '../auth/token.service';
import { ZohoApiError } from './zoho-api.error';

const MAX_TRANSIENT_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 300;
const MAX_RETRY_DELAY_MS = 5_000;
/** Connection-level errors where the request never left this machine. */
const NEVER_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

interface ZohoErrorDetail {
  code?: string;
  message?: string;
  details?: Record<string, unknown>;
}

/** Top-level errors use code/message; record-level ones nest them in data[0]. */
interface ZohoErrorBody extends ZohoErrorDetail {
  data?: ZohoErrorDetail[];
}

export interface ZohoRequestOptions {
  params?: Record<string, string | number | undefined>;
  data?: unknown;
}

/**
 * Thin wrapper around the Zoho CRM REST API. Attaches the OAuth token,
 * retries temporary failures with backoff, retries once with a fresh token
 * on 401, and turns every failure into a ZohoApiError so callers never see
 * raw Zoho/axios errors.
 */
@Injectable()
export class ZohoHttpClient {
  private readonly logger = new Logger(ZohoHttpClient.name);
  private readonly http: AxiosInstance;

  constructor(private readonly tokenService: TokenService) {
    // No fixed baseURL: each tenant may live in a different Zoho data center.
    this.http = axios.create({ timeout: 15_000 });
  }

  get<T>(
    tenantId: string,
    path: string,
    params?: ZohoRequestOptions['params'],
  ) {
    return this.request<T>(tenantId, 'GET', path, { params });
  }

  post<T>(tenantId: string, path: string, data: unknown) {
    return this.request<T>(tenantId, 'POST', path, { data });
  }

  /**
   * Calls Zoho as the given tenant, using that tenant's own token.
   * Returns the parsed body, or null when Zoho answers 204 No Content
   * (which it does for empty lists and searches with no match).
   */
  async request<T>(
    tenantId: string,
    method: Method,
    path: string,
    options: ZohoRequestOptions = {},
    isRetry = false,
  ): Promise<T | null> {
    const endpoint = `${method} /crm/v2${path}`;
    const token = await this.tokenService.getAccessToken(tenantId);
    const apiDomain = await this.tokenService.getApiDomain(tenantId);

    try {
      const res = await this.sendWithRetry<T>(
        method,
        `${apiDomain}/crm/v2${path}`,
        options,
        token,
        endpoint,
      );
      return res.status === HttpStatus.NO_CONTENT ? null : res.data;
    } catch (err) {
      if (!axios.isAxiosError(err) || !err.response) {
        throw new ZohoApiError(
          HttpStatus.BAD_GATEWAY,
          'ZOHO_UNREACHABLE',
          'Could not reach the Zoho CRM API. Please try again.',
          endpoint,
        );
      }

      const { status } = err.response;
      const error = this.extractError(err.response.data);

      // Token may have been revoked or expired early: refresh once and retry.
      // A 401 means Zoho rejected the request before running it, so retrying
      // a POST can't create a duplicate. A scope mismatch won't be fixed by a
      // new token, so don't spend a refresh on it.
      if (
        status === HttpStatus.UNAUTHORIZED &&
        !isRetry &&
        error.code !== 'OAUTH_SCOPE_MISMATCH'
      ) {
        await this.tokenService.refreshAccessToken(tenantId, token);
        return this.request<T>(tenantId, method, path, options, true);
      }

      throw new ZohoApiError(
        status >= 500 ? HttpStatus.BAD_GATEWAY : status,
        error.code ?? `HTTP_${status}`,
        error.message ?? 'Zoho CRM request failed.',
        endpoint,
        error.details,
      );
    }
  }

  /**
   * Retries temporary failures (Zoho 5xx, 429, timeouts, network drops) a
   * couple of times with growing delays. 4xx errors are never retried: the
   * same request would fail the same way. 401 is handled separately above.
   */
  private async sendWithRetry<T>(
    method: Method,
    url: string,
    options: ZohoRequestOptions,
    token: string,
    endpoint: string,
  ): Promise<AxiosResponse<T>> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.http.request<T>({
          method,
          url,
          params: options.params,
          data: options.data,
          headers: { Authorization: `Zoho-oauthtoken ${token}` },
        });
      } catch (err) {
        if (
          attempt >= MAX_TRANSIENT_RETRIES ||
          !this.isRetryable(err, method)
        ) {
          throw err;
        }
        const delay = this.retryDelay(err, attempt);
        this.logger.warn(
          `${endpoint} failed (${this.describe(err)}), retry ${attempt + 1}/${MAX_TRANSIENT_RETRIES} in ${delay}ms`,
        );
        await this.sleep(delay);
      }
    }
  }

  private isRetryable(err: unknown, method: Method): boolean {
    if (!axios.isAxiosError(err)) return false;
    const status = err.response?.status;
    const safeToRepeat = method.toUpperCase() === 'GET';

    // 429: Zoho refused the request without running it, so any method is safe.
    if (status === HttpStatus.TOO_MANY_REQUESTS) return true;
    // 5xx or a timeout: a POST may already have created the record, and
    // repeating it would make a duplicate. Only GETs are retried.
    if (status !== undefined) return status >= 500 && safeToRepeat;
    // No response. If the connection never opened, nothing reached Zoho.
    if (NEVER_SENT_CODES.has(err.code ?? '')) return true;
    return safeToRepeat;
  }

  private retryDelay(err: unknown, attempt: number): number {
    const backoff = RETRY_BASE_DELAY_MS * 3 ** attempt; // 300ms, 900ms
    const jitter = Math.floor(Math.random() * 100);
    const retryAfter = axios.isAxiosError(err)
      ? Number(err.response?.headers?.['retry-after']) * 1000
      : NaN;
    const wait = Number.isFinite(retryAfter)
      ? Math.max(backoff, retryAfter)
      : backoff;
    return Math.min(wait + jitter, MAX_RETRY_DELAY_MS);
  }

  private describe(err: unknown): string {
    if (!axios.isAxiosError(err)) return 'unknown error';
    return err.response
      ? `HTTP ${err.response.status}`
      : (err.code ?? 'network error');
  }

  /** Separate method so tests can skip the real waiting. */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private extractError(raw: unknown): ZohoErrorDetail {
    if (!raw || typeof raw !== 'object') return {};
    const body = raw as ZohoErrorBody;
    if (body.code) return body;
    const record = Array.isArray(body.data) ? body.data[0] : undefined;
    return record?.code ? record : {};
  }
}
