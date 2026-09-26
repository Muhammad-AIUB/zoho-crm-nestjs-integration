import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Redirect,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';

@Controller('oauth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly tokenService: TokenService,
  ) {}

  /** Sends the browser to Zoho's consent screen. */
  @Get('login')
  @Redirect()
  login() {
    return { url: this.authService.buildAuthorizationUrl(), statusCode: 302 };
  }

  /** Zoho redirects here with ?code=...&state=... after the user approves. */
  @Get('callback')
  async callback(
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    if (error) {
      throw new BadRequestException(`Zoho authorization failed: ${error}`);
    }
    if (!code) {
      throw new BadRequestException('Missing "code" query parameter.');
    }
    if (!this.authService.consumeState(state)) {
      throw new BadRequestException(
        'Invalid or expired OAuth state. Start again from /oauth/login.',
      );
    }

    const tokens = await this.tokenService.exchangeCode(code);

    // Tokens stay server-side; only confirm the connection.
    return {
      message: 'Zoho account connected successfully.',
      expiresAt: new Date(tokens.expires_at).toISOString(),
    };
  }
}
