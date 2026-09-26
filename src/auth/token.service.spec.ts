import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { ZohoApiError } from '../zoho/zoho-api.error';
import { StoredTokens } from './interfaces/zoho-tokens.interface';
import { TokenStoreService } from './token-store.service';
import { TokenService } from './token.service';

const SECRET = 'super-secret-client-secret';

const config = {
  getOrThrow: (key: string) =>
    ({
      ZOHO_ACCOUNTS_URL: 'https://accounts.zoho.com',
      ZOHO_CLIENT_ID: 'client-id',
      ZOHO_CLIENT_SECRET: SECRET,
      ZOHO_REDIRECT_URI: 'http://localhost:3000/oauth/callback',
    })[key],
} as unknown as ConfigService;

/** In-memory stand-in for tokens.json. */
class MemoryStore {
  tokens: StoredTokens | null = null;
  async read() {
    return this.tokens ? { ...this.tokens } : null;
  }
  async save(tokens: StoredTokens) {
    this.tokens = { ...tokens };
  }
}

const tokensExpiringIn = (ms: number, access = 'old-access'): StoredTokens => ({
  access_token: access,
  refresh_token: 'refresh-1',
  expires_at: Date.now() + ms,
});

describe('TokenService', () => {
  let store: MemoryStore;
  let service: TokenService;
  let post: jest.SpyInstance;

  beforeEach(() => {
    store = new MemoryStore();
    service = new TokenService(config, store as unknown as TokenStoreService);
    post = jest.spyOn(axios, 'post').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { data: { access_token: 'new-access', expires_in: 3600 } };
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns the stored token while it is outside the expiry buffer', async () => {
    store.tokens = tokensExpiringIn(10 * 60_000);
    await expect(service.getAccessToken()).resolves.toBe('old-access');
    expect(post).not.toHaveBeenCalled();
  });

  it('refreshes before expiry once inside the 60s buffer', async () => {
    store.tokens = tokensExpiringIn(30_000);
    await expect(service.getAccessToken()).resolves.toBe('new-access');
    expect(post).toHaveBeenCalledTimes(1);
    // Zoho doesn't return a new refresh token on refresh, so the old one is kept.
    expect(store.tokens?.refresh_token).toBe('refresh-1');
  });

  it('makes a single refresh call for many concurrent requests', async () => {
    store.tokens = tokensExpiringIn(-1000);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => service.getAccessToken()),
    );
    expect(results).toEqual(Array(5).fill('new-access'));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('skips the refresh when the rejected token was already replaced', async () => {
    store.tokens = tokensExpiringIn(10 * 60_000, 'already-refreshed');
    await expect(service.refreshAccessToken('old-access')).resolves.toBe(
      'already-refreshed',
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('asks the user to log in when there are no tokens', async () => {
    await expect(service.getAccessToken()).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
      zohoCode: 'NOT_AUTHORIZED',
    });
  });

  it('maps Zoho token throttling ("Access Denied") to 429', async () => {
    store.tokens = tokensExpiringIn(-1000);
    post.mockResolvedValueOnce({ data: { error: 'Access Denied' } });
    await expect(service.getAccessToken()).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
      zohoCode: 'ACCESS_DENIED',
    });
  });

  it('never puts the client secret into a thrown error', async () => {
    store.tokens = tokensExpiringIn(-1000);
    const axiosError = Object.assign(new Error('Network Error'), {
      isAxiosError: true,
      config: { data: `client_secret=${SECRET}` },
    });
    post.mockRejectedValueOnce(axiosError);

    const err = await service.getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZohoApiError);
    expect(JSON.stringify(err)).not.toContain(SECRET);
    expect((err as Error).message).not.toContain(SECRET);
  });
});
