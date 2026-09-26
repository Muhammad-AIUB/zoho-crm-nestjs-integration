import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as os from 'os';
import * as path from 'path';
import request, { Response } from 'supertest';
import { ZohoApiError } from '../src/zoho/zoho-api.error';
import { ZohoHttpClient } from '../src/zoho/zoho-http-client.service';

const SECRET = 'e2e-client-secret-value';

// process.env wins over .env, so these tests never touch real credentials.
Object.assign(process.env, {
  ZOHO_CLIENT_ID: 'e2e-client-id',
  ZOHO_CLIENT_SECRET: SECRET,
  ZOHO_REDIRECT_URI: 'http://localhost:3000/oauth/callback',
  ZOHO_ACCOUNTS_URL: 'https://accounts.zoho.com',
  ZOHO_API_DOMAIN: 'https://www.zohoapis.com',
  TOKEN_STORE_DIR: path.join(os.tmpdir(), `zoho-e2e-${process.pid}`),
});

/** Every response body we see, checked at the end for leaked secrets. */
const bodies: string[] = [];
const record = (res: Response) => {
  bodies.push(res.text ?? '');
  return res;
};

async function createApp(zohoOverride?: object): Promise<INestApplication> {
  // Imported after env is set: ConfigModule.forRoot reads env at import time.
  const { AppModule } = await import('../src/app.module');
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (zohoOverride) {
    builder = builder.overrideProvider(ZohoHttpClient).useValue(zohoOverride);
  }
  const app = (await builder.compile()).createNestApplication();
  await app.init();
  return app;
}

describe('App (no Zoho connection yet)', () => {
  let app: INestApplication;
  beforeAll(async () => (app = await createApp()));
  afterAll(() => app.close());

  const get = (url: string, tenant = 'acme') =>
    request(app.getHttpServer()).get(url).set('X-Tenant-Id', tenant);

  it('GET /oauth/login?tenant= redirects to Zoho and sets the state cookie', async () => {
    const res = record(
      await request(app.getHttpServer()).get('/oauth/login?tenant=acme'),
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.host).toBe('accounts.zoho.com');
    expect(location.searchParams.get('access_type')).toBe('offline');
    expect(location.searchParams.get('prompt')).toBe('consent');
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain(
      `zoho_oauth_state=${location.searchParams.get('state')}`,
    );
    expect(cookie).toContain('HttpOnly');
  });

  it('GET /oauth/login requires a tenant', async () => {
    const res = record(await request(app.getHttpServer()).get('/oauth/login'));
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('tenant');
  });

  it('GET /oauth/callback rejects a state without the matching cookie', async () => {
    const login = await request(app.getHttpServer()).get(
      '/oauth/login?tenant=acme',
    );
    const state = new URL(login.headers.location).searchParams.get('state');
    const res = record(
      await request(app.getHttpServer()).get(
        `/oauth/callback?code=abc&state=${state}`,
      ),
    );
    expect(res.status).toBe(400);
  });

  it('GET /leads tells the tenant how to connect when it has no tokens', async () => {
    const res = record(await get('/leads'));
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      statusCode: 401,
      error: 'NOT_AUTHORIZED',
      path: '/leads',
    });
    expect(res.body.message).toContain('/oauth/login?tenant=acme');
    expect(res.body.timestamp).toBeDefined();
  });

  it('GET /leads requires the X-Tenant-Id header', async () => {
    const res = record(await request(app.getHttpServer()).get('/leads'));
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('X-Tenant-Id');
  });

  it('rejects tenant ids that could escape the token directory', async () => {
    const res = record(await get('/leads', '../../etc'));
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('Invalid tenant id');
  });

  it('GET /leads/:id rejects non-numeric IDs before calling Zoho', async () => {
    const res = record(await get('/leads/abc'));
    expect(res.status).toBe(400);
  });

  describe('POST /leads validation messages', () => {
    const valid = {
      First_Name: 'Test',
      Last_Name: 'Candidate',
      Company: 'W3SCLOUD Assessment',
      Email: 'test@example.com',
    };
    const post = (body: object) =>
      request(app.getHttpServer())
        .post('/leads')
        .set('X-Tenant-Id', 'acme')
        .send(body);
    const without = (field: keyof typeof valid) => {
      const body: Record<string, string> = { ...valid };
      delete body[field];
      return body;
    };

    it.each([
      ['Email', 'Email is required'],
      ['Last_Name', 'Last_Name is required'],
      ['Company', 'Company is required'],
    ] as const)(
      'missing %s → 400 "%s" (exact message)',
      async (field, message) => {
        const res = record(await post(without(field)));
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('BAD_REQUEST');
        expect(res.body.message).toEqual([message]);
      },
    );

    it('blank (whitespace-only) required fields count as missing', async () => {
      const res = record(await post({ ...valid, Last_Name: '   ' }));
      expect(res.body.message).toEqual(['Last_Name is required']);
    });

    it('reports one clear message per bad field', async () => {
      const res = record(
        await post({ First_Name: 'A', Email: 'not-an-email' }),
      );
      expect(res.status).toBe(400);
      expect([...res.body.message].sort()).toEqual([
        'Company is required',
        'Email must be a valid email address',
        'Last_Name is required',
      ]);
    });

    it('still reports length limits for values that are present', async () => {
      const res = record(await post({ ...valid, Last_Name: 'x'.repeat(81) }));
      expect(res.body.message).toEqual([
        'Last_Name must be shorter than or equal to 80 characters',
      ]);
    });
  });

  it('POST /leads rejects unknown fields', async () => {
    const res = record(
      await request(app.getHttpServer())
        .post('/leads')
        .set('X-Tenant-Id', 'acme')
        .send({ Last_Name: 'D', Company: 'C', Email: 'a@b.co', Owner: 'x' }),
    );
    expect(res.status).toBe(400);
  });

  it('rate-limits the OAuth routes', async () => {
    let last = 0;
    for (let i = 0; i < 12 && last !== 429; i++) {
      last = record(
        await request(app.getHttpServer()).get('/oauth/login?tenant=acme'),
      ).status;
    }
    expect(last).toBe(429);
  });
});

describe('App (with a fake Zoho, two tenants)', () => {
  let app: INestApplication;
  type FakeLead = { id: string; Full_Name: string; Email: string };
  /** One fake CRM per tenant. */
  const crms = new Map<string, Map<string, FakeLead>>();
  const crm = (tenant: string) => {
    if (!crms.has(tenant)) crms.set(tenant, new Map());
    return crms.get(tenant) as Map<string, FakeLead>;
  };
  let inserts = 0;

  const fakeZoho = {
    async get(tenant: string, p: string, params?: { email?: string }) {
      const leads = crm(tenant);
      if (p === '/Leads/search') {
        const hit = [...leads.values()].find((l) => l.Email === params?.email);
        return hit ? { data: [hit] } : null;
      }
      if (p === '/Leads') {
        if (!leads.size) return null; // Zoho answers 204 for an empty module
        return {
          data: [...leads.values()],
          info: {
            page: 1,
            per_page: 20,
            count: leads.size,
            more_records: false,
          },
        };
      }
      if (p === '/settings/fields') {
        return {
          fields: [
            {
              api_name: 'Last_Name',
              field_label: 'Last Name',
              data_type: 'text',
              system_mandatory: true,
              custom_field: false,
              read_only: false,
              length: 80,
            },
            {
              api_name: 'Customer_Type',
              field_label: 'Customer Type',
              data_type: 'picklist',
              system_mandatory: false,
              custom_field: true,
              read_only: false,
            },
          ],
        };
      }
      if (p === '/Leads/401') {
        throw new ZohoApiError(
          401,
          'OAUTH_SCOPE_MISMATCH',
          'invalid oauth scope to access this URL',
          'GET /crm/v2/Leads/401',
        );
      }
      if (p === '/Leads/400') {
        throw new ZohoApiError(
          400,
          'INVALID_DATA',
          'the id given seems to be invalid',
          'GET /crm/v2/Leads/400',
          { api_name: 'id' },
        );
      }
      const lead = leads.get(p.split('/').pop() as string);
      return lead ? { data: [lead] } : null;
    },
    async post(
      tenant: string,
      _p: string,
      body: { data: { Last_Name: string; Email: string }[] },
    ) {
      const id = String(9000 + ++inserts);
      const [lead] = body.data;
      crm(tenant).set(id, { id, Full_Name: lead.Last_Name, Email: lead.Email });
      return {
        data: [
          {
            code: 'SUCCESS',
            status: 'success',
            message: 'ok',
            details: { id },
          },
        ],
      };
    },
  };

  beforeAll(async () => (app = await createApp(fakeZoho)));
  afterAll(() => app.close());

  const as = (tenant: string) => ({
    get: (url: string) =>
      request(app.getHttpServer()).get(url).set('X-Tenant-Id', tenant),
    post: (url: string, body: object) =>
      request(app.getHttpServer())
        .post(url)
        .set('X-Tenant-Id', tenant)
        .send(body),
  });
  const acme = as('acme');
  const globex = as('globex');

  const lead = { Last_Name: 'Doe', Company: 'Acme', Email: 'John@Acme.com' };

  it('POST /leads creates a lead (201), then returns it as a duplicate (200)', async () => {
    const first = record(await acme.post('/leads', lead));
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      duplicate: false,
      data: { name: 'Doe', email: 'john@acme.com' },
    });

    const second = record(await acme.post('/leads', lead));
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(inserts).toBe(1);
  });

  it('GET /leads returns id, name, email, phone and paging info', async () => {
    const res = record(await acme.get('/leads'));
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toEqual({
      id: expect.any(String),
      name: 'Doe',
      email: 'john@acme.com',
      phone: null,
    });
    expect(res.body.pagination).toEqual({
      page: 1,
      perPage: 20,
      count: 1,
      moreRecords: false,
      nextPage: null,
    });
  });

  describe('tenant isolation', () => {
    it("one tenant can't see another tenant's leads", async () => {
      const res = record(await globex.get('/leads'));
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it("one tenant can't fetch another tenant's lead by id", async () => {
      const [acmeLead] = crm('acme').values();
      const res = record(await globex.get(`/leads/${acmeLead.id}`));
      expect(res.status).toBe(404);
    });

    it("duplicate check is per tenant: the same email is new in another tenant's CRM", async () => {
      const res = record(await globex.post('/leads', lead));
      expect(res.status).toBe(201);
      expect(res.body.duplicate).toBe(false);
      expect(crm('acme').size).toBe(1);
      expect(crm('globex').size).toBe(1);
    });
  });

  it('GET /leads/fields maps UI labels to API names', async () => {
    const res = record(await acme.get('/leads/fields'));
    expect(res.status).toBe(200);
    expect(res.body.module).toBe('Leads');
    expect(res.body.fields).toContainEqual({
      label: 'Customer Type',
      apiName: 'Customer_Type',
      dataType: 'picklist',
      required: false,
      custom: true,
      readOnly: false,
      maxLength: null,
    });
    expect(res.body.fields[0]).toMatchObject({
      apiName: 'Last_Name',
      required: true,
    });
  });

  it('explains OAUTH_SCOPE_MISMATCH as a missing permission, not an expired token', async () => {
    const res = record(await acme.get('/leads/401'));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('OAUTH_SCOPE_MISMATCH');
    expect(res.body.message).toContain('missing a required permission');
  });

  it('GET /leads/:id returns 404 for a missing record', async () => {
    const res = record(await acme.get('/leads/123'));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('turns Zoho error codes into readable JSON instead of the raw payload', async () => {
    const res = record(await acme.get('/leads/400'));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      statusCode: 400,
      error: 'INVALID_DATA',
      message: 'Invalid value for field "id".',
      path: '/leads/400',
      timestamp: expect.any(String),
    });
  });
});

afterAll(() => {
  for (const body of bodies) expect(body).not.toContain(SECRET);
});
