import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { StoredTokens } from './interfaces/zoho-tokens.interface';

/**
 * Persists each tenant's Zoho tokens in its own file: tokens/{tenantId}.json.
 * One file per tenant keeps tenants isolated and lets them refresh
 * independently. For production, swap this class for a database table with
 * encrypted columns; nothing else in the app needs to change.
 */
@Injectable()
export class TokenStoreService {
  private readonly logger = new Logger(TokenStoreService.name);
  private readonly dir: string;

  constructor(config: ConfigService) {
    this.dir = path.resolve(config.get<string>('TOKEN_STORE_DIR', 'tokens'));
  }

  async read(tenantId: string): Promise<StoredTokens | null> {
    try {
      const raw = await fs.readFile(this.fileFor(tenantId), 'utf8');
      return JSON.parse(raw) as StoredTokens;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      // Don't log err.message: JSON.parse errors quote part of the file,
      // which here would be part of a token.
      this.logger.error(
        `Token file for tenant "${tenantId}" is unreadable or not valid JSON (${code ?? (err as Error).name}). Reconnect via /oauth/login.`,
      );
      return null;
    }
  }

  async save(tenantId: string, tokens: StoredTokens): Promise<void> {
    const file = this.fileFor(tenantId);
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    // Write to a unique temp file then rename, so a crash or two concurrent
    // saves never leave a half-written file behind.
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    await fs.rename(tmp, file);
    this.logger.log(`Zoho tokens saved for tenant "${tenantId}"`);
  }

  private fileFor(tenantId: string): string {
    const file = path.resolve(this.dir, `${tenantId}.json`);
    // Tenant ids are validated upstream; this is a second line of defence.
    if (path.dirname(file) !== this.dir) {
      throw new Error('Tenant id resolves outside the token directory');
    }
    return file;
  }
}
