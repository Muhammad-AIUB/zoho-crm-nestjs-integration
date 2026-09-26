import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';

const SCOPE = 'ZohoCRM.modules.ALL';
const STATE_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class AuthService {
  /** CSRF protection: states we handed out and haven't seen come back yet. */
  private readonly pendingStates = new Map<string, number>();

  constructor(private readonly config: ConfigService) {}

  buildAuthorizationUrl(): string {
    const state = randomBytes(16).toString('hex');
    this.pendingStates.set(state, Date.now() + STATE_TTL_MS);

    const params = new URLSearchParams({
      scope: SCOPE,
      client_id: this.config.getOrThrow<string>('ZOHO_CLIENT_ID'),
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      redirect_uri: this.config.getOrThrow<string>('ZOHO_REDIRECT_URI'),
      state,
    });
    const accountsUrl = this.config.getOrThrow<string>('ZOHO_ACCOUNTS_URL');
    return `${accountsUrl}/oauth/v2/auth?${params.toString()}`;
  }

  /** Single-use check of the state value Zoho echoes back. */
  consumeState(state: string | undefined): boolean {
    this.dropExpiredStates();
    if (!state || !this.pendingStates.has(state)) return false;
    this.pendingStates.delete(state);
    return true;
  }

  private dropExpiredStates(): void {
    const now = Date.now();
    for (const [state, expiresAt] of this.pendingStates) {
      if (expiresAt < now) this.pendingStates.delete(state);
    }
  }
}
