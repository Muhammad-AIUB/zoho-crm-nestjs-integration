import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, Method } from 'axios';
import { TokenService } from '../auth/token.service';
import { ZohoApiError } from './zoho-api.error';

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
 * retries once with a fresh token on 401, and turns every failure into a
 * ZohoApiError so callers never see raw Zoho/axios errors.
 */
@Injectable()
export class ZohoHttpClient {
  private readonly http: AxiosInstance;

  constructor(
    config: ConfigService,
    private readonly tokenService: TokenService,
  ) {
    this.http = axios.create({
      baseURL: `${config.getOrThrow<string>('ZOHO_API_DOMAIN')}/crm/v2`,
      timeout: 15_000,
    });
  }

  get<T>(path: string, params?: ZohoRequestOptions['params']) {
    return this.request<T>('GET', path, { params });
  }

  post<T>(path: string, data: unknown) {
    return this.request<T>('POST', path, { data });
  }

  /**
   * Returns the parsed body, or null when Zoho answers 204 No Content
   * (which it does for empty lists and searches with no match).
   */
  async request<T>(
    method: Method,
    path: string,
    options: ZohoRequestOptions = {},
    isRetry = false,
  ): Promise<T | null> {
    const endpoint = `${method} /crm/v2${path}`;
    const token = await this.tokenService.getAccessToken();

    try {
      const res = await this.http.request<T>({
        method,
        url: path,
        params: options.params,
        data: options.data,
        headers: { Authorization: `Zoho-oauthtoken ${token}` },
      });
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
        await this.tokenService.refreshAccessToken(token);
        return this.request<T>(method, path, options, true);
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

  private extractError(raw: unknown): ZohoErrorDetail {
    if (!raw || typeof raw !== 'object') return {};
    const body = raw as ZohoErrorBody;
    if (body.code) return body;
    const record = Array.isArray(body.data) ? body.data[0] : undefined;
    return record?.code ? record : {};
  }
}
