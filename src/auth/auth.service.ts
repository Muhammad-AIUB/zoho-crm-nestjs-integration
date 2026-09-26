import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, timingSafeEqual } from 'crypto';

const SCOPE = 'ZohoCRM.modules.ALL';
export const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_STATES = 1000;

export interface AuthorizationRequest {
  url: string;
  state: string;
}

@Injectable()
export class AuthService {
  /** States we handed out and haven't seen come back yet (value = expiry). */
  private readonly pendingStates = new Map<string, number>();

  constructor(private readonly config: ConfigService) {}

  createAuthorizationRequest(): AuthorizationRequest {
    this.dropExpiredStates();
    // Hard cap so hammering /oauth/login can't grow memory without limit.
    // Map keeps insertion order, so the first key is the oldest.
    while (this.pendingStates.size >= MAX_PENDING_STATES) {
      const oldest = this.pendingStates.keys().next().value as string;
      this.pendingStates.delete(oldest);
    }

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
    return { url: `${accountsUrl}/oauth/v2/auth?${params.toString()}`, state };
  }

  /**
   * The state Zoho echoes back must (a) be one we issued, (b) not be used
   * yet, and (c) match the cookie set on the browser that started the flow.
   * (c) stops login CSRF: without it, an attacker could finish consent with
   * their own Zoho account and trick someone else's browser into hitting
   * the callback, connecting this server to the attacker's CRM.
   */
  consumeState(
    queryState: string | undefined,
    cookieState: string | undefined,
  ): boolean {
    this.dropExpiredStates();
    if (typeof queryState !== 'string' || typeof cookieState !== 'string') {
      return false;
    }
    if (!this.safeEqual(queryState, cookieState)) return false;
    if (!this.pendingStates.has(queryState)) return false;
    this.pendingStates.delete(queryState);
    return true;
  }

  private safeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  }

  private dropExpiredStates(): void {
    const now = Date.now();
    for (const [state, expiresAt] of this.pendingStates) {
      if (expiresAt < now) this.pendingStates.delete(state);
    }
  }
}
