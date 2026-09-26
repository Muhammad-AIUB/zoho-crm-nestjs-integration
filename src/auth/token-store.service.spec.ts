import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StoredTokens } from './interfaces/zoho-tokens.interface';
import { TokenStoreService } from './token-store.service';

const tokens = (access: string): StoredTokens => ({
  access_token: access,
  refresh_token: `${access}-refresh`,
  expires_at: Date.now() + 3_600_000,
});

describe('TokenStoreService', () => {
  let dir: string;
  let store: TokenStoreService;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zoho-tokens-'));
    const config = { get: () => dir } as unknown as ConfigService;
    store = new TokenStoreService(config);
  });

  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  it('keeps each tenant in its own file', async () => {
    await store.save('acme', tokens('acme-token'));
    await store.save('globex', tokens('globex-token'));

    expect((await fs.readdir(dir)).sort()).toEqual([
      'acme.json',
      'globex.json',
    ]);
    expect((await store.read('acme'))?.access_token).toBe('acme-token');
    expect((await store.read('globex'))?.access_token).toBe('globex-token');
  });

  it('returns null for a tenant that never connected', async () => {
    await expect(store.read('nobody')).resolves.toBeNull();
  });

  it('refuses ids that would escape the token directory', async () => {
    await expect(store.save('../evil', tokens('x'))).rejects.toThrow(
      /outside the token directory/,
    );
  });
});
