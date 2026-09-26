import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';

const config = {
  getOrThrow: (key: string) =>
    ({
      ZOHO_CLIENT_ID: 'client-id',
      ZOHO_REDIRECT_URI: 'http://localhost:3000/oauth/callback',
      ZOHO_ACCOUNTS_URL: 'https://accounts.zoho.com',
    })[key],
} as unknown as ConfigService;

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(() => {
    service = new AuthService(config);
  });

  it('builds the Zoho consent URL with the required parameters', () => {
    const { url, state } = service.createAuthorizationRequest('acme');
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      'https://accounts.zoho.com/oauth/v2/auth',
    );
    expect(Object.fromEntries(parsed.searchParams)).toMatchObject({
      scope: 'ZohoCRM.modules.ALL,ZohoCRM.settings.fields.READ',
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    expect(state).toMatch(/^[0-9a-f]{32}$/);
  });

  it('issues a different state every time', () => {
    const states = new Set(
      Array.from(
        { length: 50 },
        () => service.createAuthorizationRequest('acme').state,
      ),
    );
    expect(states.size).toBe(50);
  });

  it('accepts a state once, and only with the matching cookie', () => {
    const { state } = service.createAuthorizationRequest('acme');
    expect(service.consumeState(state, undefined)).toBeNull();
    expect(service.consumeState(state, 'someone-elses-state')).toBeNull();
    expect(service.consumeState(state, state)).toBe('acme');
    expect(service.consumeState(state, state)).toBeNull(); // replay
  });

  it('returns the tenant that started each flow', () => {
    const acme = service.createAuthorizationRequest('acme').state;
    const globex = service.createAuthorizationRequest('globex').state;
    expect(service.consumeState(globex, globex)).toBe('globex');
    expect(service.consumeState(acme, acme)).toBe('acme');
  });

  it('rejects states it never issued', () => {
    expect(service.consumeState('forged', 'forged')).toBeNull();
  });

  it('caps pending states so /oauth/login cannot grow memory forever', () => {
    const { state: first } = service.createAuthorizationRequest('acme');
    for (let i = 0; i < 1500; i++) service.createAuthorizationRequest('acme');
    expect(service.consumeState(first, first)).toBeNull();
  });
});
