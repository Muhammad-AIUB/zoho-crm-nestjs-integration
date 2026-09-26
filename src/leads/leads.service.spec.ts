import { ZohoApiError } from '../zoho/zoho-api.error';
import { ZohoHttpClient } from '../zoho/zoho-http-client.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import { LeadsService } from './leads.service';

type Record_ = { id: string; Last_Name: string; Email: string };

/**
 * Fake Zoho with one CRM per tenant. Its search index never catches up,
 * like right after an insert.
 */
class FakeZoho {
  inserts = 0;
  records = new Map<string, Record_>(); // key: `${tenant}:${id}`
  insertsByTenant = new Map<string, number>();
  searchResults: Record_[] = [];
  getByIdError: Error | null = null;

  private tick = () => new Promise((r) => setTimeout(r, 5));

  async get(tenantId: string, path: string) {
    await this.tick();
    if (path.endsWith('/search')) {
      return this.searchResults.length ? { data: this.searchResults } : null;
    }
    if (this.getByIdError) throw this.getByIdError;
    const id = path.split('/').pop() as string;
    const record = this.records.get(`${tenantId}:${id}`);
    return record ? { data: [record] } : null;
  }

  async post(tenantId: string, _path: string, body: { data: CreateLeadDto[] }) {
    await this.tick();
    const id = String(5000 + ++this.inserts);
    this.records.set(`${tenantId}:${id}`, { id, ...body.data[0] });
    this.insertsByTenant.set(
      tenantId,
      (this.insertsByTenant.get(tenantId) ?? 0) + 1,
    );
    return {
      data: [
        { code: 'SUCCESS', status: 'success', message: 'ok', details: { id } },
      ],
    };
  }
}

const dto = (email = 'jane@acme.com'): CreateLeadDto => ({
  Last_Name: 'Doe',
  Company: 'Acme',
  Email: email,
});

describe('LeadsService.create', () => {
  let zoho: FakeZoho;
  let service: LeadsService;

  beforeEach(() => {
    zoho = new FakeZoho();
    service = new LeadsService(zoho as unknown as ZohoHttpClient);
  });

  it('creates one lead for simultaneous requests with the same email', async () => {
    const results = await Promise.all([
      service.create('acme', dto()),
      service.create('acme', dto()),
      service.create('acme', dto()),
    ]);
    expect(results.map((r) => r.created)).toEqual([true, false, false]);
    expect(new Set(results.map((r) => r.lead.id)).size).toBe(1);
    expect(zoho.inserts).toBe(1);
  });

  it('still creates leads for different emails', async () => {
    await Promise.all([
      service.create('acme', dto('a@x.com')),
      service.create('acme', dto('b@x.com')),
    ]);
    expect(zoho.inserts).toBe(2);
  });

  it('returns the existing record when search finds the email', async () => {
    zoho.searchResults = [
      { id: '42', Last_Name: 'Old', Email: 'jane@acme.com' },
    ];
    const result = await service.create('acme', dto());
    expect(result).toMatchObject({ created: false, lead: { id: '42' } });
    expect(zoho.inserts).toBe(0);
  });

  it('creates again if the recently created lead was deleted in Zoho', async () => {
    await service.create('acme', dto());
    zoho.records.clear();
    zoho.getByIdError = new ZohoApiError(
      400,
      'INVALID_DATA',
      'invalid id',
      'GET',
    );

    const result = await service.create('acme', dto());
    expect(result.created).toBe(true);
    expect(zoho.inserts).toBe(2);
  });

  it('turns a per-record failure into a ZohoApiError', async () => {
    zoho.post = async () => ({
      data: [
        {
          code: 'MANDATORY_NOT_FOUND',
          status: 'error',
          message: 'required field not found',
          details: { api_name: 'Company', id: '' },
        },
      ],
    });
    await expect(service.create('acme', dto())).rejects.toMatchObject({
      zohoCode: 'MANDATORY_NOT_FOUND',
    });
  });

  it("keeps duplicate prevention per tenant: the same email is new in each tenant's CRM", async () => {
    const [acme1, globex, acme2] = await Promise.all([
      service.create('acme', dto()),
      service.create('globex', dto()),
      service.create('acme', dto()),
    ]);
    expect(acme1.created).toBe(true);
    expect(globex.created).toBe(true);
    expect(acme2.created).toBe(false);
    expect(zoho.insertsByTenant.get('acme')).toBe(1);
    expect(zoho.insertsByTenant.get('globex')).toBe(1);
  });
});

describe('LeadsService.findAll', () => {
  const lead = { id: '1', Full_Name: 'A B', Email: 'a@b.co', Phone: null };

  it('passes the tenant, page and per_page to Zoho and points to the next page', async () => {
    const get = jest.fn(async () => ({
      data: [lead],
      info: { page: 2, per_page: 1, count: 1, more_records: true },
    }));
    const service = new LeadsService({ get } as unknown as ZohoHttpClient);

    const res = await service.findAll('acme', { page: 2, per_page: 1 });

    expect(get).toHaveBeenCalledWith(
      'acme',
      '/Leads',
      expect.objectContaining({ page: 2, per_page: 1 }),
    );
    expect(res.pagination).toEqual({
      page: 2,
      perPage: 1,
      count: 1,
      moreRecords: true,
      nextPage: 3,
    });
  });

  it('returns an empty last page when Zoho answers 204', async () => {
    const get = jest.fn(async () => null);
    const service = new LeadsService({ get } as unknown as ZohoHttpClient);

    const res = await service.findAll('acme', { page: 9, per_page: 20 });

    expect(res.data).toEqual([]);
    expect(res.pagination).toMatchObject({
      page: 9,
      moreRecords: false,
      nextPage: null,
    });
  });
});
