import { Module } from '@nestjs/common';
import { ZohoModule } from '../zoho/zoho.module';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

@Module({
  imports: [ZohoModule],
  controllers: [LeadsController],
  providers: [LeadsService],
})
export class LeadsModule {}
