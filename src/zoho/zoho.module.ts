import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ZohoHttpClient } from './zoho-http-client.service';

@Module({
  imports: [AuthModule],
  providers: [ZohoHttpClient],
  exports: [ZohoHttpClient],
})
export class ZohoModule {}
