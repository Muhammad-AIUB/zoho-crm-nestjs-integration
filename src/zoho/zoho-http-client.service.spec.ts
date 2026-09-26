import { ConfigService } from '@nestjs/config';
import { AxiosInstance } from 'axios';
import { TokenService } from '../auth/token.service';
import { ZohoApiError } from './zoho-api.error';
import { ZohoHttpClient } from './zoho-http-client.service';

const config = {
  getOrThrow: () => 'https://www.zohoapis.com',
} as unknown as ConfigService;

const zohoError = (status: number, data: unknown) =>
  Object.assign(new Error(`HTTP ${status}`), {
    isAxiosError: true,
    response: { status, data },
  });

describe('ZohoHttpClient', () => {
  let currentToken: string;
  let tokens: { getAccessToken: jest.Mock; refreshAccessToken: jest.Mock };
  let client: ZohoHttpClient;
  let request: jest.SpyInstance;
  let sleep: jest.SpyInstance;

  beforeEach(() => {
    currentToken = 't1';
    tokens = {
      getAccessToken: jest.fn(async () => currentToken),
      refreshAccessToken: jest.fn(async () => {
        currentToken = 't2';
        return currentToken;
      }),
    };
    client = new ZohoHttpClient(config, tokens as unknown as TokenService);
    const http = (client as unknown as { http: AxiosInstance }).http;
    request = jest.spyOn(http, 'request');
    sleep = jest
      .spyOn(client as unknown as { sleep: () => Promise<void> }, 'sleep')
      .mockResolvedValue(undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns null on 204 No Content', async () => {
    request.mockResolvedValueOnce({ status: 204, data: '' });
    await expect(
      client.get('acme', '/Leads/search', { email: 'x' }),
    ).resolves.toBeNull();
  });

  it('refreshes once on 401 and retries with the new token', async () => {
    request
      .mockRejectedValueOnce(zohoError(401, { code: 'INVALID_TOKEN' }))
      .mockResolvedValueOnce({ status: 200, data: { data: [] } });

    await expect(client.get('acme', '/Leads')).resolves.toEqual({ data: [] });
    expect(tokens.refreshAccessToken).toHaveBeenCalledWith('acme', 't1');
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0].headers.Authorization).toBe(
      'Zoho-oauthtoken t2',
    );
  });

  it('gives up after one retry (no retry loop)', async () => {
    request.mockRejectedValue(zohoError(401, { code: 'INVALID_TOKEN' }));
    await expect(client.get('acme', '/Leads')).rejects.toMatchObject({
      status: 401,
      zohoCode: 'INVALID_TOKEN',
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(tokens.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('does not spend a refresh on a scope mismatch', async () => {
    request.mockRejectedValue(zohoError(401, { code: 'OAUTH_SCOPE_MISMATCH' }));
    await expect(client.get('acme', '/Leads')).rejects.toBeInstanceOf(
      ZohoApiError,
    );
    expect(tokens.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('reads record-level errors from data[0]', async () => {
    request.mockRejectedValueOnce(
      zohoError(400, {
        data: [
          {
            code: 'MANDATORY_NOT_FOUND',
            message: 'required field not found',
            details: { api_name: 'Last_Name' },
            status: 'error',
          },
        ],
      }),
    );
    await expect(client.post('acme', '/Leads', {})).rejects.toMatchObject({
      status: 400,
      zohoCode: 'MANDATORY_NOT_FOUND',
      details: { api_name: 'Last_Name' },
    });
  });

  describe('transient-failure retries', () => {
    const networkError = (code: string) =>
      Object.assign(new Error(code), { isAxiosError: true, code });
    const ok = { status: 200, data: { data: [] } };

    it('retries a GET on 5xx and succeeds', async () => {
      request
        .mockRejectedValueOnce(zohoError(503, 'Service Unavailable'))
        .mockRejectedValueOnce(zohoError(502, 'Bad Gateway'))
        .mockResolvedValueOnce(ok);

      await expect(client.get('acme', '/Leads')).resolves.toEqual({ data: [] });
      expect(request).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('stops after 2 retries and returns 502', async () => {
      request.mockRejectedValue(zohoError(503, 'Service Unavailable'));
      await expect(client.get('acme', '/Leads')).rejects.toMatchObject({
        status: 502,
      });
      expect(request).toHaveBeenCalledTimes(3);
    });

    it('backs off longer on each retry', async () => {
      request.mockRejectedValue(zohoError(503, ''));
      await client.get('acme', '/Leads').catch(() => undefined);
      const [first, second] = sleep.mock.calls.map(([ms]) => ms as number);
      expect(first).toBeGreaterThanOrEqual(300);
      expect(second).toBeGreaterThanOrEqual(900);
    });

    it('retries a GET on timeouts and network errors, then gives up', async () => {
      request.mockRejectedValue(networkError('ECONNABORTED'));
      await expect(client.get('acme', '/Leads')).rejects.toMatchObject({
        status: 502,
        zohoCode: 'ZOHO_UNREACHABLE',
      });
      expect(request).toHaveBeenCalledTimes(3);
    });

    it('never retries 4xx errors', async () => {
      request.mockRejectedValue(zohoError(400, { code: 'INVALID_DATA' }));
      await expect(client.get('acme', '/Leads')).rejects.toMatchObject({
        status: 400,
      });
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('does not retry a POST on 5xx or timeout (it may already have been created)', async () => {
      request.mockRejectedValueOnce(zohoError(500, ''));
      await expect(client.post('acme', '/Leads', {})).rejects.toMatchObject({
        status: 502,
      });
      request.mockRejectedValueOnce(networkError('ECONNABORTED'));
      await expect(client.post('acme', '/Leads', {})).rejects.toMatchObject({
        zohoCode: 'ZOHO_UNREACHABLE',
      });
      expect(request).toHaveBeenCalledTimes(2);
    });

    it('retries a POST when Zoho never ran it (429 or connection refused)', async () => {
      request
        .mockRejectedValueOnce(zohoError(429, { code: 'TOO_MANY_REQUESTS' }))
        .mockRejectedValueOnce(networkError('ECONNREFUSED'))
        .mockResolvedValueOnce(ok);
      await expect(client.post('acme', '/Leads', {})).resolves.toEqual({
        data: [],
      });
      expect(request).toHaveBeenCalledTimes(3);
    });
  });
});
