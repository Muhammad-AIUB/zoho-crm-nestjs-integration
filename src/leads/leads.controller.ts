import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { TenantId } from '../tenancy/tenant-id.decorator';
import { CreateLeadDto } from './dto/create-lead.dto';
import { LeadIdParamDto } from './dto/lead-id-param.dto';
import { ListLeadsQueryDto } from './dto/list-leads-query.dto';
import { LeadsService } from './leads.service';

/** All routes act on the tenant named in the X-Tenant-Id header. */
@Controller('leads')
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @Get()
  findAll(@TenantId() tenantId: string, @Query() query: ListLeadsQueryDto) {
    return this.leadsService.findAll(tenantId, query);
  }

  /** Label → API name mapping for Leads. Declared before :id on purpose. */
  @Get('fields')
  getFields(@TenantId() tenantId: string) {
    return this.leadsService.getFields(tenantId);
  }

  @Get(':id')
  async findOne(@TenantId() tenantId: string, @Param() { id }: LeadIdParamDto) {
    return { data: await this.leadsService.findOne(tenantId, id) };
  }

  /** 201 when a new lead is created, 200 when an existing one is returned. */
  @Post()
  async create(
    @TenantId() tenantId: string,
    @Body() dto: CreateLeadDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { created, lead } = await this.leadsService.create(tenantId, dto);
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return {
      duplicate: !created,
      message: created
        ? 'Lead created successfully.'
        : 'A lead with this email already exists. Returning the existing record.',
      data: lead,
    };
  }
}
