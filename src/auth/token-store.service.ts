import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import * as path from 'path';
import { StoredTokens } from './interfaces/zoho-tokens.interface';

/**
 * Persists Zoho tokens to a local JSON file. Good enough for a single
 * instance; swap this class for a DB/secret-store backed one in production.
 */
@Injectable()
export class TokenStoreService {
  private readonly logger = new Logger(TokenStoreService.name);
  private readonly filePath: string;

  constructor(config: ConfigService) {
    this.filePath = path.resolve(
      config.get<string>('TOKEN_STORE_PATH', 'tokens.json'),
    );
  }

  async read(): Promise<StoredTokens | null> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      return JSON.parse(raw) as StoredTokens;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      this.logger.error(`Could not read token file: ${(err as Error).message}`);
      return null;
    }
  }

  async save(tokens: StoredTokens): Promise<void> {
    // Write to a temp file then rename so a crash never leaves half a file.
    const tmp = `${this.filePath}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.filePath);
    this.logger.log('Zoho tokens saved');
  }
}
