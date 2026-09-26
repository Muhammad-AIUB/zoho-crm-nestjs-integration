import { Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { ZohoExceptionFilter } from './common/filters/zoho-exception.filter';
import { envValidationSchema } from './config/env.validation';
import { LeadsModule } from './leads/leads.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
    }),
    AuthModule,
    LeadsModule,
  ],
  providers: [
    // Registered here (not in main.ts) so e2e tests get the same setup.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        stopAtFirstError: true,
      }),
    },
    { provide: APP_FILTER, useClass: ZohoExceptionFilter },
  ],
})
export class AppModule {}
