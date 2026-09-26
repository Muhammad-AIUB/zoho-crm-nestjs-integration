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

/** In-memory stand-in for tokens/{tenant}.json. */
class MemoryStore {
  byTenant = new Map<string, StoredTokens>();
  async read(tenantId: string) {
    const t = this.byTenant.get(tenantId);
    return t ? { ...t } : null;
  }
  async save(tenantId: string, tokens: StoredTokens) {
    this.byTenant.set(tenantId, { ...tokens });
  }
}

const tokensExpiringIn = (
  ms: number,
  access = 'old-access',
  refresh = 'refresh-1',
): StoredTokens => ({
  access_token: access,
  refresh_token: refresh,
  expires_at: Date.now() + ms,
});

describe('TokenService', () => {
  let store: MemoryStore;
  let service: TokenService;
  let post: jest.SpyInstance;

  beforeEach(() => {
    store = new MemoryStore();
    service = new TokenService(config, store as unknown as TokenStoreService);
    // Fake token endpoint: echoes which refresh token was used in the new access token.
    post = jest
      .spyOn(axios, 'post')
      .mockImplementation(async (_url: string, body: unknown) => {
        await new Promise((r) => setTimeout(r, 10));
        const refresh = new URLSearchParams(String(body)).get('refresh_token');
        return {
          data: { access_token: `new-access-for-${refresh}`, expires_in: 3600 },
        };
      });
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns the stored token while it is outside the expiry buffer', async () => {
    store.byTenant.set('acme', tokensExpiringIn(10 * 60_000));
    await expect(service.getAccessToken('acme')).resolves.toBe('old-access');
    expect(post).not.toHaveBeenCalled();
  });

  it('refreshes before expiry once inside the 60s buffer', async () => {
    store.byTenant.set('acme', tokensExpiringIn(30_000));
    await expect(service.getAccessToken('acme')).resolves.toBe(
      'new-access-for-refresh-1',
    );
    expect(post).toHaveBeenCalledTimes(1);
    // Zoho doesn't return a new refresh token on refresh, so the old one is kept.
    expect(store.byTenant.get('acme')?.refresh_token).toBe('refresh-1');
  });

  it('makes a single refresh call for many concurrent requests', async () => {
    store.byTenant.set('acme', tokensExpiringIn(-1000));
    const results = await Promise.all(
      Array.from({ length: 5 }, () => service.getAccessToken('acme')),
    );
    expect(new Set(results)).toEqual(new Set(['new-access-for-refresh-1']));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('skips the refresh when the rejected token was already replaced', async () => {
    store.byTenant.set(
      'acme',
      tokensExpiringIn(10 * 60_000, 'already-refreshed'),
    );
    await expect(
      service.refreshAccessToken('acme', 'old-access'),
    ).resolves.toBe('already-refreshed');
    expect(post).not.toHaveBeenCalled();
  });

  it('asks that tenant to connect when it has no tokens', async () => {
    await expect(service.getAccessToken('acme')).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
      zohoCode: 'NOT_AUTHORIZED',
      message: expect.stringContaining('/oauth/login?tenant=acme'),
    });
  });

  it('maps Zoho token throttling ("Access Denied") to 429', async () => {
    store.byTenant.set('acme', tokensExpiringIn(-1000));
    post.mockResolvedValueOnce({ data: { error: 'Access Denied' } });
    await expect(service.getAccessToken('acme')).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
      zohoCode: 'ACCESS_DENIED',
    });
  });

  it('never puts the client secret into a thrown error', async () => {
    store.byTenant.set('acme', tokensExpiringIn(-1000));
    const axiosError = Object.assign(new Error('Network Error'), {
      isAxiosError: true,
      config: { data: `client_secret=${SECRET}` },
    });
    post.mockRejectedValueOnce(axiosError);

    const err = await service.getAccessToken('acme').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZohoApiError);
    expect(JSON.stringify(err)).not.toContain(SECRET);
    expect((err as Error).message).not.toContain(SECRET);
  });

  describe('tenant isolation', () => {
    it('refreshes each tenant with its own refresh token and never mixes them', async () => {
      store.byTenant.set('acme', tokensExpiringIn(-1000, 'a', 'acme-refresh'));
      store.byTenant.set(
        'globex',
        tokensExpiringIn(-1000, 'g', 'globex-refresh'),
      );

      const [acme, globex] = await Promise.all([
        service.getAccessToken('acme'),
        service.getAccessToken('globex'),
      ]);

      expect(acme).toBe('new-access-for-acme-refresh');
      expect(globex).toBe('new-access-for-globex-refresh');
      // One refresh per tenant: tenants don't share (or wait on) a refresh.
      expect(post).toHaveBeenCalledTimes(2);
      expect(store.byTenant.get('acme')?.refresh_token).toBe('acme-refresh');
      expect(store.byTenant.get('globex')?.refresh_token).toBe(
        'globex-refresh',
      );
    });

    it("one tenant being disconnected doesn't affect another", async () => {
      store.byTenant.set('acme', tokensExpiringIn(10 * 60_000, 'acme-token'));
      await expect(service.getAccessToken('acme')).resolves.toBe('acme-token');
      await expect(service.getAccessToken('globex')).rejects.toMatchObject({
        zohoCode: 'NOT_AUTHORIZED',
      });
    });
  });
});
