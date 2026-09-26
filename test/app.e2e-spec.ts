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
  TOKEN_STORE_PATH: path.join(os.tmpdir(), `zoho-e2e-${process.pid}.json`),
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

  it('GET /oauth/login redirects to Zoho and sets the state cookie', async () => {
    const res = record(await request(app.getHttpServer()).get('/oauth/login'));
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

  it('GET /oauth/callback rejects a state without the matching cookie', async () => {
    const login = await request(app.getHttpServer()).get('/oauth/login');
    const state = new URL(login.headers.location).searchParams.get('state');
    const res = record(
      await request(app.getHttpServer()).get(
        `/oauth/callback?code=abc&state=${state}`,
      ),
    );
    expect(res.status).toBe(400);
  });

  it('GET /leads explains how to connect when there are no tokens', async () => {
    const res = record(await request(app.getHttpServer()).get('/leads'));
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      statusCode: 401,
      error: 'NOT_AUTHORIZED',
      path: '/leads',
    });
    expect(res.body.message).toContain('/oauth/login');
    expect(res.body.timestamp).toBeDefined();
  });

  it('GET /leads/:id rejects non-numeric IDs before calling Zoho', async () => {
    const res = record(await request(app.getHttpServer()).get('/leads/abc'));
    expect(res.status).toBe(400);
  });

  it('POST /leads validates the body', async () => {
    const res = record(
      await request(app.getHttpServer())
        .post('/leads')
        .send({ First_Name: 'A', Email: 'not-an-email' }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('BAD_REQUEST');
    expect(res.body.message).toEqual(
      expect.arrayContaining([expect.stringContaining('Last_Name')]),
    );
  });

  it('POST /leads rejects unknown fields', async () => {
    const res = record(
      await request(app.getHttpServer())
        .post('/leads')
        .send({ Last_Name: 'D', Company: 'C', Email: 'a@b.co', Owner: 'x' }),
    );
    expect(res.status).toBe(400);
  });

  it('rate-limits the OAuth routes', async () => {
    let last = 0;
    for (let i = 0; i < 12 && last !== 429; i++) {
      last = record(
        await request(app.getHttpServer()).get('/oauth/login'),
      ).status;
    }
    expect(last).toBe(429);
  });
});

describe('App (with a fake Zoho)', () => {
  let app: INestApplication;
  const leads = new Map<
    string,
    { id: string; Full_Name: string; Email: string }
  >();
  let inserts = 0;

  const fakeZoho = {
    async get(p: string, params?: { email?: string }) {
      if (p === '/Leads/search') {
        const hit = [...leads.values()].find((l) => l.Email === params?.email);
        return hit ? { data: [hit] } : null;
      }
      if (p === '/Leads') {
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
      if (p === '/Leads/400') {
        throw new ZohoApiError(
          400,
          'INVALID_DATA',
          'the id given seems to be invalid',
          'GET /crm/v2/Leads/400',
          {
            api_name: 'id',
          },
        );
      }
      const lead = leads.get(p.split('/').pop() as string);
      return lead ? { data: [lead] } : null;
    },
    async post(
      _p: string,
      body: { data: { Last_Name: string; Email: string }[] },
    ) {
      const id = String(9000 + ++inserts);
      const [lead] = body.data;
      leads.set(id, { id, Full_Name: lead.Last_Name, Email: lead.Email });
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

  const lead = { Last_Name: 'Doe', Company: 'Acme', Email: 'John@Acme.com' };

  it('POST /leads creates a lead (201), then returns it as a duplicate (200)', async () => {
    const first = record(
      await request(app.getHttpServer()).post('/leads').send(lead),
    );
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      duplicate: false,
      data: { name: 'Doe', email: 'john@acme.com' },
    });

    const second = record(
      await request(app.getHttpServer()).post('/leads').send(lead),
    );
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(inserts).toBe(1);
  });

  it('GET /leads returns id, name, email, phone and paging info', async () => {
    const res = record(await request(app.getHttpServer()).get('/leads'));
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

  it('GET /leads/:id returns 404 for a missing record', async () => {
    const res = record(await request(app.getHttpServer()).get('/leads/123'));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('turns Zoho error codes into readable JSON instead of the raw payload', async () => {
    const res = record(await request(app.getHttpServer()).get('/leads/400'));
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
