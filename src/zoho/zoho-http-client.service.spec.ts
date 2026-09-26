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
  });

  it('returns null on 204 No Content', async () => {
    request.mockResolvedValueOnce({ status: 204, data: '' });
    await expect(
      client.get('/Leads/search', { email: 'x' }),
    ).resolves.toBeNull();
  });

  it('refreshes once on 401 and retries with the new token', async () => {
    request
      .mockRejectedValueOnce(zohoError(401, { code: 'INVALID_TOKEN' }))
      .mockResolvedValueOnce({ status: 200, data: { data: [] } });

    await expect(client.get('/Leads')).resolves.toEqual({ data: [] });
    expect(tokens.refreshAccessToken).toHaveBeenCalledWith('t1');
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0].headers.Authorization).toBe(
      'Zoho-oauthtoken t2',
    );
  });

  it('gives up after one retry (no retry loop)', async () => {
    request.mockRejectedValue(zohoError(401, { code: 'INVALID_TOKEN' }));
    await expect(client.get('/Leads')).rejects.toMatchObject({
      status: 401,
      zohoCode: 'INVALID_TOKEN',
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(tokens.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('does not spend a refresh on a scope mismatch', async () => {
    request.mockRejectedValue(zohoError(401, { code: 'OAUTH_SCOPE_MISMATCH' }));
    await expect(client.get('/Leads')).rejects.toBeInstanceOf(ZohoApiError);
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
    await expect(client.post('/Leads', {})).rejects.toMatchObject({
      status: 400,
      zohoCode: 'MANDATORY_NOT_FOUND',
      details: { api_name: 'Last_Name' },
    });
  });

  it('maps Zoho 5xx to 502 and network failures to ZOHO_UNREACHABLE', async () => {
    request.mockRejectedValueOnce(zohoError(503, 'Service Unavailable'));
    await expect(client.get('/Leads')).rejects.toMatchObject({ status: 502 });

    request.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(client.get('/Leads')).rejects.toMatchObject({
      status: 502,
      zohoCode: 'ZOHO_UNREACHABLE',
    });
  });
});
