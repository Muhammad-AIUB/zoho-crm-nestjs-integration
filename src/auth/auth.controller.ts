import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Redirect,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { TenantId, TenantRequest } from '../tenancy/tenant-id.decorator';
import { AuthService, STATE_TTL_MS } from './auth.service';
import { TokenService } from './token.service';

const STATE_COOKIE = 'zoho_oauth_state';

// The OAuth flow is a once-in-a-while action; keep it tight.
@Throttle({ default: { ttl: 60_000, limit: 10 } })
@Controller('oauth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly tokenService: TokenService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Sends the browser to Zoho's consent screen to connect one tenant's
   * Zoho account: /oauth/login?tenant=acme
   */
  @Get('login')
  @Redirect()
  login(
    @TenantId() tenantId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { url, state } =
      this.authService.createAuthorizationRequest(tenantId);
    // SameSite=Lax still sends the cookie on Zoho's top-level redirect back.
    res.cookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config
        .getOrThrow<string>('ZOHO_REDIRECT_URI')
        .startsWith('https://'),
      path: '/oauth',
      maxAge: STATE_TTL_MS,
    });
    return { url, statusCode: 302 };
  }

  /** Zoho redirects here with ?code=...&state=... after the user approves. */
  @Get('callback')
  async callback(
    @Req() req: TenantRequest,
    @Res({ passthrough: true }) res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    const cookieState = readCookie(req, STATE_COOKIE);
    res.clearCookie(STATE_COOKIE, { path: '/oauth' });

    if (error) {
      throw new BadRequestException(`Zoho authorization failed: ${error}`);
    }
    if (typeof code !== 'string' || !code) {
      throw new BadRequestException('Missing "code" query parameter.');
    }
    // The tenant comes from our own server-side state record, never from the
    // callback URL, so it can't be swapped on the way back from Zoho.
    const tenantId = this.authService.consumeState(state, cookieState);
    if (!tenantId) {
      throw new BadRequestException(
        'Invalid or expired OAuth state. Start again from /oauth/login in the same browser.',
      );
    }
    req.tenantId = tenantId;

    const tokens = await this.tokenService.exchangeCode(tenantId, code);

    // Tokens stay server-side; only confirm the connection.
    return {
      message: `Zoho account connected successfully for tenant "${tenantId}".`,
      tenant: tenantId,
      expiresAt: new Date(tokens.expires_at).toISOString(),
    };
  }
}

/** Tiny cookie reader so we don't need cookie-parser for one value. */
function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key !== name) continue;
    try {
      return decodeURIComponent(rest.join('='));
    } catch {
      return undefined; // malformed cookie, treat as missing
    }
  }
  return undefined;
}
