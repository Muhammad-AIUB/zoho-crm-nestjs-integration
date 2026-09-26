import { ZohoApiError } from '../zoho/zoho-api.error';
import { ZohoHttpClient } from '../zoho/zoho-http-client.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import { LeadsService } from './leads.service';

type Record_ = { id: string; Last_Name: string; Email: string };

/** Fake Zoho whose search index never catches up, like right after an insert. */
class FakeZoho {
  inserts = 0;
  records = new Map<string, Record_>();
  searchResults: Record_[] = [];
  getByIdError: Error | null = null;

  private tick = () => new Promise((r) => setTimeout(r, 5));

  async get(path: string) {
    await this.tick();
    if (path.endsWith('/search')) {
      return this.searchResults.length ? { data: this.searchResults } : null;
    }
    if (this.getByIdError) throw this.getByIdError;
    const record = this.records.get(path.split('/').pop() as string);
    return record ? { data: [record] } : null;
  }

  async post(_path: string, body: { data: CreateLeadDto[] }) {
    await this.tick();
    const id = String(5000 + ++this.inserts);
    this.records.set(id, { id, ...body.data[0] });
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
      service.create(dto()),
      service.create(dto()),
      service.create(dto()),
    ]);
    expect(results.map((r) => r.created)).toEqual([true, false, false]);
    expect(new Set(results.map((r) => r.lead.id)).size).toBe(1);
    expect(zoho.inserts).toBe(1);
  });

  it('still creates leads for different emails', async () => {
    await Promise.all([
      service.create(dto('a@x.com')),
      service.create(dto('b@x.com')),
    ]);
    expect(zoho.inserts).toBe(2);
  });

  it('returns the existing record when search finds the email', async () => {
    zoho.searchResults = [
      { id: '42', Last_Name: 'Old', Email: 'jane@acme.com' },
    ];
    const result = await service.create(dto());
    expect(result).toMatchObject({ created: false, lead: { id: '42' } });
    expect(zoho.inserts).toBe(0);
  });

  it('creates again if the recently created lead was deleted in Zoho', async () => {
    await service.create(dto());
    zoho.records.clear();
    zoho.getByIdError = new ZohoApiError(
      400,
      'INVALID_DATA',
      'invalid id',
      'GET',
    );

    const result = await service.create(dto());
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
    await expect(service.create(dto())).rejects.toMatchObject({
      zohoCode: 'MANDATORY_NOT_FOUND',
    });
  });
});
