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
import { CreateLeadDto } from './dto/create-lead.dto';
import { LeadIdParamDto } from './dto/lead-id-param.dto';
import { ListLeadsQueryDto } from './dto/list-leads-query.dto';
import { LeadsService } from './leads.service';

@Controller('leads')
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @Get()
  findAll(@Query() query: ListLeadsQueryDto) {
    return this.leadsService.findAll(query);
  }

  @Get(':id')
  async findOne(@Param() { id }: LeadIdParamDto) {
    return { data: await this.leadsService.findOne(id) };
  }

  /** 201 when a new lead is created, 200 when an existing one is returned. */
  @Post()
  async create(
    @Body() dto: CreateLeadDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { created, lead } = await this.leadsService.create(dto);
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
