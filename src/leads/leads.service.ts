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
  LeadField,
  ZohoFieldMeta,
  ZohoLeadRecord,
  ZohoListResponse,
  ZohoWriteResult,
} from './interfaces/lead.interface';

const MODULE = '/Leads';
const LEAD_FIELDS = 'Full_Name,First_Name,Last_Name,Email,Phone';
/** How long we trust our own record of a create while Zoho indexes it. */
const RECENT_CREATE_TTL_MS = 10 * 60 * 1000;

export interface CreateLeadResult {
  created: boolean;
  lead: Lead;
}

/**
 * Every method takes the tenant explicitly and passes it down to the Zoho
 * client, so a call can only ever use that tenant's token and CRM account.
 */
@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);
  /** Pending create per tenant+email, used to run same-email creates in order. */
  private readonly createQueue = new Map<string, Promise<CreateLeadResult>>();
  /** Leads we created recently, by tenant+email, until Zoho's search catches up. */
  private readonly recentlyCreated = new Map<
    string,
    { id: string; expiresAt: number }
  >();

  constructor(private readonly zoho: ZohoHttpClient) {}

  async findAll(tenantId: string, query: ListLeadsQueryDto) {
    const res = await this.zoho.get<ZohoListResponse<ZohoLeadRecord>>(
      tenantId,
      MODULE,
      { fields: LEAD_FIELDS, page: query.page, per_page: query.per_page },
    );

    // Zoho answers 204 (null here) for a page past the end.
    const page = res?.info?.page ?? query.page ?? 1;
    const moreRecords = res?.info?.more_records ?? false;
    return {
      data: (res?.data ?? []).map((r) => this.toLead(r)),
      pagination: {
        page,
        perPage: res?.info?.per_page ?? query.per_page,
        count: res?.info?.count ?? 0,
        moreRecords,
        nextPage: moreRecords ? page + 1 : null,
      },
    };
  }

  /**
   * The CRM UI shows field *labels* ("Customer Type") but the API only
   * accepts *API names* ("Customer_Type"). Labels can be renamed by admins
   * at any time; API names can't, so integrations must use API names.
   * This asks Zoho for the real mapping instead of guessing it. Custom
   * fields differ per org, so the answer is per tenant too.
   */
  async getFields(
    tenantId: string,
  ): Promise<{ module: string; fields: LeadField[] }> {
    const res = await this.zoho.get<{ fields: ZohoFieldMeta[] }>(
      tenantId,
      '/settings/fields',
      { module: 'Leads' },
    );
    return {
      module: 'Leads',
      fields: (res?.fields ?? []).map((f) => ({
        label: f.field_label ?? f.display_label ?? f.api_name,
        apiName: f.api_name,
        dataType: f.data_type ?? null,
        required: f.system_mandatory ?? false,
        custom: f.custom_field ?? false,
        readOnly: f.read_only ?? false,
        maxLength: f.length ?? null,
      })),
    };
  }

  async findOne(tenantId: string, id: string): Promise<Lead> {
    const res = await this.zoho.get<ZohoListResponse<ZohoLeadRecord>>(
      tenantId,
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

  async findByEmail(tenantId: string, email: string): Promise<Lead | null> {
    const res = await this.zoho.get<ZohoListResponse<ZohoLeadRecord>>(
      tenantId,
      `${MODULE}/search`,
      { email },
    );
    const record = res?.data?.[0];
    return record ? this.toLead(record) : null;
  }

  /**
   * Creates the lead unless one with the same email already exists in this
   * tenant's CRM. Calls for the same tenant+email run one after another, so
   * two concurrent requests can't both pass the duplicate check.
   */
  async create(
    tenantId: string,
    dto: CreateLeadDto,
  ): Promise<CreateLeadResult> {
    // Tenant ids can't contain ":", so this key is unambiguous.
    const key = `${tenantId}:${dto.Email}`;
    const previous = this.createQueue.get(key) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.createIfMissing(tenantId, key, dto));

    this.createQueue.set(key, run);
    try {
      return await run;
    } finally {
      if (this.createQueue.get(key) === run) this.createQueue.delete(key);
    }
  }

  private async createIfMissing(
    tenantId: string,
    key: string,
    dto: CreateLeadDto,
  ): Promise<CreateLeadResult> {
    // Zoho's search index lags behind inserts, so check our own recent
    // creates first and look them up by ID (which doesn't use the index).
    const recent = this.findRecentlyCreated(key);
    if (recent) {
      try {
        const lead = await this.findOne(tenantId, recent);
        this.logger.log(
          `[${tenantId}] Lead with this email was just created (id ${lead.id}), skipping create`,
        );
        return { created: false, lead };
      } catch (err) {
        // A deleted record can come back as 204 (-> NotFound) or as a 4xx
        // like INVALID_DATA. Either way it's gone, so fall through to a
        // normal search + create. Auth and 5xx errors still propagate.
        const gone =
          err instanceof NotFoundException ||
          (err instanceof ZohoApiError &&
            (err.status === HttpStatus.BAD_REQUEST ||
              err.status === HttpStatus.NOT_FOUND));
        if (!gone) throw err;
        this.recentlyCreated.delete(key);
      }
    }

    const existing = await this.findByEmail(tenantId, dto.Email);
    if (existing) {
      this.logger.log(
        `[${tenantId}] Lead with this email already exists (id ${existing.id}), skipping create`,
      );
      return { created: false, lead: existing };
    }

    const res = await this.zoho.post<{ data: ZohoWriteResult[] }>(
      tenantId,
      MODULE,
      { data: [dto] },
    );
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

    this.rememberCreated(key, result.details.id);

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

  private findRecentlyCreated(key: string): string | null {
    const entry = this.recentlyCreated.get(key);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.recentlyCreated.delete(key);
      return null;
    }
    return entry.id;
  }

  private rememberCreated(key: string, id: string): void {
    const now = Date.now();
    for (const [k, entry] of this.recentlyCreated) {
      if (entry.expiresAt < now) this.recentlyCreated.delete(k);
    }
    this.recentlyCreated.set(key, {
      id,
      expiresAt: now + RECENT_CREATE_TTL_MS,
    });
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
