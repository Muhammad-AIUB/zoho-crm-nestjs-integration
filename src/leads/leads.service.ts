import {
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ZohoApiError } from '../zoho/zoho-api.error';
import { ZohoHttpClient } from '../zoho/zoho-http-client.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import { ListLeadsQueryDto } from './dto/list-leads-query.dto';
import {
  Lead,
  ZohoLeadRecord,
  ZohoListResponse,
  ZohoWriteResult,
} from './interfaces/lead.interface';

const MODULE = '/Leads';
const LEAD_FIELDS = 'Full_Name,First_Name,Last_Name,Email,Phone';

export interface CreateLeadResult {
  created: boolean;
  lead: Lead;
}

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(private readonly zoho: ZohoHttpClient) {}

  async findAll(query: ListLeadsQueryDto) {
    const res = await this.zoho.get<ZohoListResponse<ZohoLeadRecord>>(MODULE, {
      fields: LEAD_FIELDS,
      page: query.page,
      per_page: query.per_page,
    });

    return {
      data: (res?.data ?? []).map((r) => this.toLead(r)),
      page: res?.info?.page ?? query.page,
      perPage: res?.info?.per_page ?? query.per_page,
      moreRecords: res?.info?.more_records ?? false,
    };
  }

  async findOne(id: string): Promise<Lead> {
    const res = await this.zoho.get<ZohoListResponse<ZohoLeadRecord>>(
      `${MODULE}/${id}`,
    );
    const record = res?.data?.[0];
    if (!record) {
      throw new NotFoundException(
        `Lead with id ${id} was not found in Zoho CRM.`,
      );
    }
    return this.toLead(record);
  }

  async findByEmail(email: string): Promise<Lead | null> {
    const res = await this.zoho.get<ZohoListResponse<ZohoLeadRecord>>(
      `${MODULE}/search`,
      { email },
    );
    const record = res?.data?.[0];
    return record ? this.toLead(record) : null;
  }

  /** Creates the lead unless one with the same email already exists. */
  async create(dto: CreateLeadDto): Promise<CreateLeadResult> {
    const existing = await this.findByEmail(dto.Email);
    if (existing) {
      this.logger.log(
        `Lead with this email already exists (id ${existing.id}), skipping create`,
      );
      return { created: false, lead: existing };
    }

    const res = await this.zoho.post<{ data: ZohoWriteResult[] }>(MODULE, {
      data: [dto],
    });
    const result = res?.data?.[0];

    // Zoho can report per-record failures inside an otherwise OK response.
    if (!result || result.status !== 'success' || !result.details.id) {
      throw new ZohoApiError(
        HttpStatus.BAD_REQUEST,
        result?.code ?? 'CREATE_FAILED',
        result?.message ?? 'Zoho did not create the lead.',
        `POST /crm/v2${MODULE}`,
        result?.details,
      );
    }

    return {
      created: true,
      lead: {
        id: result.details.id,
        name: [dto.First_Name, dto.Last_Name].filter(Boolean).join(' '),
        email: dto.Email,
        phone: dto.Phone ?? null,
      },
    };
  }

  private toLead(record: ZohoLeadRecord): Lead {
    const name =
      record.Full_Name ??
      [record.First_Name, record.Last_Name].filter(Boolean).join(' ');
    return {
      id: record.id,
      name,
      email: record.Email ?? null,
      phone: record.Phone ?? null,
    };
  }
}
