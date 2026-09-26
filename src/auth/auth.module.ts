import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokenStoreService } from './token-store.service';
import { TokenService } from './token.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, TokenService, TokenStoreService],
  exports: [TokenService],
})
export class AuthModule {}
