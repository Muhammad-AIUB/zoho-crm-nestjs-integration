# Zoho CRM NestJS Integration

A NestJS + TypeScript service that connects to Zoho CRM with OAuth 2.0 and exposes a clean REST API for Leads: list (paginated), get by ID, create with duplicate check, and field metadata. It is multi-tenant: several companies can each connect their own Zoho account, and their tokens and data stay separate.

## Project structure

```
src/
├── tenancy/
│   └── tenant-id.decorator.ts     resolves + validates the tenant for each request
├── auth/                          OAuth flow + token handling
│   ├── auth.controller.ts         GET /oauth/login, GET /oauth/callback
│   ├── auth.service.ts            builds the Zoho consent URL, CSRF state check
│   ├── token.service.ts           code exchange, auto-refresh, per-tenant data center
│   └── token-store.service.ts     tokens/{tenantId}.json read/write
├── zoho/
│   ├── zoho-http-client.service.ts  shared Zoho CRM client (auth header, retries, error mapping)
│   └── zoho-api.error.ts          normalised Zoho error type
├── leads/                         GET /leads, GET /leads/fields, GET /leads/:id, POST /leads
│   └── dto/                       class-validator DTOs
├── common/filters/
│   └── zoho-exception.filter.ts   global filter: clean JSON errors + context logging
├── config/env.validation.ts       fails fast if required env vars are missing
├── app.module.ts                  wires modules, validation pipe, error filter, rate limiter
└── main.ts
test/app.e2e-spec.ts               HTTP-level smoke tests
```

## Architecture

Four small modules, each with one job. Dependencies only point one way: `leads → zoho → auth`, and all three use `tenancy`.

```
            HTTP client  (X-Tenant-Id: acme)
                 │
   ┌─────────────┴───────────────┐
   │  ThrottlerGuard (per IP)     │   global: 60 req/min, /oauth: 10 req/min
   │  ValidationPipe (DTOs)       │   rejects bad input before any Zoho call
   │  @TenantId() decorator       │   validates tenant id, 400 if missing/unsafe
   └─────────────┬───────────────┘
                 │
  AuthController │ LeadsController         controllers: HTTP only, no logic
                 │        │
   AuthService   │   LeadsService          business rules (state check, dedup per tenant)
   TokenService ◄┼── ZohoHttpClient        single place that talks to the CRM API
   TokenStore    │        │                (tenant's token + tenant's data center)
   tokens/       │        ▼
    acme.json    │  www.zohoapis.{com|eu|in|…}/crm/v2
    globex.json  ▼
     accounts.zoho.com/oauth/v2
                 │
   ZohoExceptionFilter (global)            every error → one JSON shape + one log line
```

A `POST /leads` request, end to end:

1. `ThrottlerGuard` checks the caller's rate limit.
2. `@TenantId()` reads `X-Tenant-Id` and validates it. `ValidationPipe` validates the body against `CreateLeadDto` (required fields, email format, no unknown fields). Invalid input stops here, and Zoho is never called.
3. `LeadsService.create(tenant, dto)` queues the request behind any in-flight create for the same tenant and email (see *Duplicate prevention*).
4. `ZohoHttpClient` gets **that tenant's** token from `TokenService` (refreshing it if needed) and calls **that tenant's** Zoho data center: `GET /Leads/search?email=`, then `POST /Leads`. Temporary failures are retried (see *Retry strategy*).
5. Any failure becomes a `ZohoApiError`, which the global filter turns into clean JSON and a structured log line tagged with the tenant.

## Requirements

- Node.js 18+ (tested on 20)
- A Zoho account and a **Server-based Application** client from the [Zoho API Console](https://api-console.zoho.com/)
  - Set the Authorized Redirect URI to `http://localhost:3000/oauth/callback`

## Installation

```bash
git clone https://github.com/Muhammad-AIUB/zoho-crm-nestjs-integration.git
cd zoho-crm-nestjs-integration
npm install
```

## Environment variables

Copy the example file and fill in your own values:

```bash
cp .env.example .env
```

| Variable | Description | Example |
|---|---|---|
| `PORT` | Port the API listens on | `3000` |
| `ZOHO_CLIENT_ID` | Client ID from the Zoho API Console | `1000.XXXX` |
| `ZOHO_CLIENT_SECRET` | Client secret from the Zoho API Console | `xxxx` |
| `ZOHO_REDIRECT_URI` | Must exactly match the URI registered in Zoho | `http://localhost:3000/oauth/callback` |
| `ZOHO_ACCOUNTS_URL` | Zoho accounts server used for OAuth | `https://accounts.zoho.com` |
| `ZOHO_API_DOMAIN` | Default API domain. Each tenant's own `api_domain` from Zoho is used when available | `https://www.zohoapis.com` |
| `TOKEN_STORE_DIR` | Folder for per-tenant token files (optional) | `tokens` |

If your Zoho account is in another data center, use the matching accounts URL (e.g. `accounts.zoho.eu`, `accounts.zoho.in`).

The app validates these on startup and refuses to start if a required one is missing. `.env` and `tokens/` are git-ignored.

## Running

```bash
npm run start:dev     # watch mode
# or
npm run build && npm run start:prod
```

## Tenants

Every request says which tenant (company / Zoho org) it acts for:

- API calls: the `X-Tenant-Id` header, e.g. `-H "X-Tenant-Id: acme"`
- `/oauth/login`: the `?tenant=` query parameter, because a browser following a link can't send custom headers

Tenant IDs are 1–63 characters of letters, digits, `-` and `_`, and are lower-cased. Anything else, including a missing tenant, is rejected with `400` before any work happens. For a single-company setup, just pick one ID (e.g. `acme`) and use it everywhere.

## Step 1 — connect Zoho (OAuth flow)

Do this once per tenant before calling any `/leads` endpoint for it.

1. Start the server.
2. Open **http://localhost:3000/oauth/login?tenant=acme** in a browser.
3. You are redirected to Zoho's consent screen (`scope=ZohoCRM.modules.ALL,ZohoCRM.settings.fields.READ`, `access_type=offline`, `prompt=consent`). Log in with that tenant's Zoho account and click **Accept**.
   - `ZohoCRM.modules.ALL`: read, create and search records.
   - `ZohoCRM.settings.fields.READ`: read field metadata for `GET /leads/fields`. A token granted without it gets `401 OAUTH_SCOPE_MISMATCH` on that endpoint; reconnecting fixes it.
4. Zoho redirects back to `/oauth/callback?code=...&state=...`. The server checks the `state` (see below), works out which tenant started the flow, exchanges the code for tokens, and saves them to `tokens/acme.json`. You'll see:

```json
{
  "message": "Zoho account connected successfully for tenant \"acme\".",
  "tenant": "acme",
  "expiresAt": "2026-09-27T10:30:00.000Z"
}
```

Repeat with `?tenant=globex` (and a different Zoho account) to connect a second tenant. Tokens are never returned in responses or written to logs.

**How the `state` check works (CSRF protection, RFC 6749 §10.12).** `/oauth/login` generates 128 random bits with `crypto.randomBytes` and stores them server-side for 10 minutes, together with the tenant. It also sets them in an `HttpOnly`, `SameSite=Lax` cookie. The callback only accepts the code if the `state` in the URL matches the cookie, matches a state the server issued, and hasn't been used yet. It is deleted on first use, so it can't be replayed. The cookie check stops login CSRF, where an attacker completes consent with their own Zoho account and tricks another browser into opening the callback link.

The tenant is taken from the server's own state record, not from the callback URL, so it can't be swapped on the way back from Zoho. Start and finish the flow in the same browser.

## Endpoints

All `/leads` endpoints require the `X-Tenant-Id` header.

### `GET /leads`

Returns leads with ID, name, email and phone. Optional query params: `page` (default 1), `per_page` (default 20, max 200).

```bash
curl "http://localhost:3000/leads?page=1&per_page=2" -H "X-Tenant-Id: acme"
```

```json
{
  "data": [
    {
      "id": "5725767000000524157",
      "name": "John Doe",
      "email": "john.doe@acme.com",
      "phone": "+1 555 0100"
    },
    {
      "id": "5725767000000524158",
      "name": "Jane Smith",
      "email": "jane@globex.com",
      "phone": null
    }
  ],
  "pagination": {
    "page": 1,
    "perPage": 2,
    "count": 2,
    "moreRecords": true,
    "nextPage": 2
  }
}
```

The paging values come straight from Zoho's `info` block (`page`, `per_page`, `count`, `more_records`). To walk every lead, keep requesting `nextPage` until it is `null`. Each page is one Zoho API call, so large syncs should use a bigger `per_page` (max 200).

### `GET /leads/fields`

Returns the mapping between what the CRM UI shows (**field label**) and what the API expects (**API name**), straight from Zoho's field metadata API (`GET /crm/v2/settings/fields?module=Leads`).

```bash
curl http://localhost:3000/leads/fields -H "X-Tenant-Id: acme"
```

```json
{
  "module": "Leads",
  "fields": [
    { "label": "Last Name", "apiName": "Last_Name", "dataType": "text", "required": true, "custom": false, "readOnly": false, "maxLength": 80 },
    { "label": "Lead Source", "apiName": "Lead_Source", "dataType": "picklist", "required": false, "custom": false, "readOnly": false, "maxLength": 120 },
    { "label": "Customer Type", "apiName": "Customer_Type", "dataType": "picklist", "required": false, "custom": true, "readOnly": false, "maxLength": null }
  ]
}
```

**Why it matters:** the API ignores labels. Sending `"Customer Type": "Retail"` does nothing; it has to be `"Customer_Type": "Retail"`. Admins can rename labels at any time, but API names stay fixed, so integrations should always use API names. This endpoint lets you look them up (including custom fields and which ones are required) instead of guessing. Custom fields differ between orgs, so the answer is per tenant. You can also find them in Zoho under *Setup → Developer Space → APIs → API Names*.

### `GET /leads/:id`

```bash
curl http://localhost:3000/leads/5725767000000524157 -H "X-Tenant-Id: acme"
```

```json
{
  "data": {
    "id": "5725767000000524157",
    "name": "John Doe",
    "email": "john.doe@acme.com",
    "phone": "+1 555 0100"
  }
}
```

Not found (including a lead that belongs to another tenant) → `404`:

```json
{
  "statusCode": 404,
  "error": "NOT_FOUND",
  "message": "Lead with id 5725767000000000000 was not found in Zoho CRM.",
  "path": "/leads/5725767000000000000",
  "timestamp": "2026-09-27T09:30:00.000Z"
}
```

### `POST /leads`

| Field | Required | Notes |
|---|---|---|
| `Last_Name` | yes | mandatory in Zoho |
| `Company` | yes | mandatory in Zoho's default Leads layout |
| `Email` | yes | used for duplicate detection |
| `First_Name` | no | |
| `Phone` | no | digits, spaces, `+ - ( ) .` |

```bash
curl -X POST http://localhost:3000/leads \
  -H "X-Tenant-Id: acme" \
  -H "Content-Type: application/json" \
  -d '{
    "First_Name": "John",
    "Last_Name": "Doe",
    "Company": "Acme Inc",
    "Email": "john.doe@acme.com",
    "Phone": "+1 555 0100"
  }'
```

Before creating, the service searches that tenant's Zoho Leads by email (`GET /crm/v2/Leads/search?email=...`).

New lead → `201 Created`:

```json
{
  "duplicate": false,
  "message": "Lead created successfully.",
  "data": {
    "id": "5725767000000524157",
    "name": "John Doe",
    "email": "john.doe@acme.com",
    "phone": "+1 555 0100"
  }
}
```

Email already exists → `200 OK` with the existing record, nothing is created:

```json
{
  "duplicate": true,
  "message": "A lead with this email already exists. Returning the existing record.",
  "data": {
    "id": "5725767000000524157",
    "name": "John Doe",
    "email": "john.doe@acme.com",
    "phone": "+1 555 0100"
  }
}
```

Validation error → `400` (request never reaches Zoho):

```json
{
  "statusCode": 400,
  "error": "BAD_REQUEST",
  "message": ["Last_Name is required", "Email must be a valid email address"],
  "path": "/leads",
  "timestamp": "2026-09-27T09:30:00.000Z"
}
```

## Working demo (live Zoho CRM, tested 2026-09-27)

Tested end to end against a real Zoho CRM account (US data center, `https://www.zohoapis.com`) with tenant `acme`, connected through `GET /oauth/login?tenant=acme` using scopes `ZohoCRM.modules.ALL,ZohoCRM.settings.fields.READ`. Every call below sent `X-Tenant-Id: acme`. Secrets, tokens and personal data are not shown.

| # | Test case | Request | Observed result |
|---|---|---|---|
| a | Field metadata (UI label → API name) | `GET /leads/fields` | **200**, 46 real Leads fields from `/crm/v2/settings/fields`. For example "Title" → `Designation`, "No. of Employees" → `No_of_Employees`, "Lead Image" → `Record_Image`, "Address - Zip / Postal Code" → `Zip_Code`. Only `Last_Name` is marked `required: true` in this org's layout |
| b | Read leads with pagination | `GET /leads?page=1&per_page=5`, then `page=2` | **200**, real records (ID, name, email, phone). Page 1: `moreRecords: true, nextPage: 2`. Page 2: `moreRecords: false, nextPage: null` |
| c | Insert a lead | `POST /leads` with `First_Name: Test, Last_Name: Candidate, Company: W3SCLOUD Assessment, Email: test.candidate.w3scloud@example.com, Phone: +8801700000000` | **201**, `duplicate: false`, Record ID **`7636833000000702001`**; the record appears in Zoho CRM |
| d | Retrieve the inserted lead by ID | `GET /leads/7636833000000702001` | **200**, same ID, name (`Test Candidate`, from Zoho's own `Full_Name`), email and phone |
| e | Duplicate prevention | Same `POST /leads` again (same email) | **200**, `duplicate: true`, same ID `7636833000000702001`, no new record. Caught first by the recent-creates guard (lookup by ID); after a server restart, caught by the Zoho **Search API** (`GET /Leads/search?email=`) |
| f1 | Expired/invalid access token, automatic recovery | Access token in `tokens/acme.json` replaced with garbage, then `GET /leads` | **200**. Zoho answered 401, the app refreshed the token with the refresh token, retried once and succeeded. Log: `Refreshing access token for tenant "acme"` |
| f2 | Invalid token that can't be recovered | Access **and** refresh token corrupted, then `GET /leads` | **401** `{"error":"INVALID_CODE","message":"The authorization code or refresh token is invalid or expired. Visit /oauth/login again."}`. Valid tokens restored afterwards and `GET /leads` returned 200 again |
| g | Missing required field (validation) | `POST /leads` without `Email` / `Last_Name` / `Company` | **400** before any Zoho call: `["Email is required"]`, `["Last_Name is required"]`, `["Company is required"]` |
| h | No secrets in logs | Searched all server log files (normal and error output) | **0 matches** for the client secret, the access token, the refresh token, any Zoho token-shaped string (`1000.<32hex>.<32hex>`), `Zoho-oauthtoken`, `client_secret` and `refresh_token=` |

Example error log line (from f2), showing the context logged without any token:

    ERROR [ExceptionFilter] {"timestamp":"2026-09-26T20:47:56.077Z","route":"GET /leads","tenant":"acme","zohoEndpoint":"POST /oauth/v2/token","zohoCode":"INVALID_CODE","status":401,"message":"The authorization code or refresh token is invalid or expired. Visit /oauth/login again."}

## Error handling

A global exception filter turns every Zoho failure into the same JSON shape, with a readable message instead of the raw Zoho payload:

| Situation | Status | `error` | Example message |
|---|---|---|---|
| Missing / invalid tenant | 400 | `BAD_REQUEST` | Missing tenant. Send the "X-Tenant-Id" header (or "?tenant=" on /oauth/login). |
| Tenant not connected yet | 401 | `NOT_AUTHORIZED` | Tenant "acme" has not connected a Zoho account. Visit /oauth/login?tenant=acme to connect it. |
| Token invalid and refresh failed | 401 | `INVALID_TOKEN` | Zoho access token is invalid or expired and could not be refreshed. Visit /oauth/login to reconnect. |
| Token lacks a permission | 401 | `OAUTH_SCOPE_MISMATCH` | The Zoho connection is missing a required permission (OAuth scope). Reconnect via /oauth/login to grant the current scopes. |
| Bad module | 400 | `INVALID_MODULE` | The requested Zoho CRM module does not exist or is not supported. |
| Missing field | 400 | `MANDATORY_NOT_FOUND` | Required field "Last_Name" is missing. |
| Bad data / record ID | 400 | `INVALID_DATA` | Invalid value for field "Email". |
| Caller over the rate limit | 429 | `TOO_MANY_REQUESTS` | Too many requests. Please wait a minute and try again. |
| Too many token refreshes | 429 | `ACCESS_DENIED` | Zoho is rate-limiting token requests. Please retry in a few minutes. |
| Wrong client ID/secret/redirect URI in `.env` | 500 | `INVALID_CLIENT` | Zoho rejected this server's OAuth client settings. Check ZOHO_CLIENT_ID, ... |
| Zoho down / 5xx (after retries) | 502 | `ZOHO_UNREACHABLE` | Could not reach the Zoho CRM API. Please try again. |

Each error is logged as one JSON line with the route, tenant, Zoho endpoint, Zoho error code, status and timestamp, for example:

```
ERROR [ExceptionFilter] {"timestamp":"2026-09-27T09:30:00.000Z","route":"POST /leads","tenant":"acme","zohoEndpoint":"POST /crm/v2/Leads","zohoCode":"MANDATORY_NOT_FOUND","status":400,"message":"required field not found","details":{"api_name":"Last_Name"}}
```

The logged error object is built by hand from safe fields, so the client secret, access token and refresh token never end up in logs (raw axios errors, which contain request headers, are never logged or rethrown).

## How token refresh works

- After the OAuth callback, `tokens/{tenant}.json` holds the `access_token`, `refresh_token`, the tenant's `api_domain` and an `expires_at` timestamp (Zoho access tokens last 1 hour).
- Every Zoho call goes through `ZohoHttpClient`, which asks `TokenService.getAccessToken(tenant)` for a token.
- If the token expires within the next 60 seconds, `TokenService` calls `POST {ZOHO_ACCOUNTS_URL}/oauth/v2/token` with `grant_type=refresh_token`, saves the new access token (keeping the existing refresh token, since Zoho doesn't issue a new one) and returns it.
- Why 60 seconds early: `expires_at` is computed when the response arrives, so it's already a little late. The buffer also means a token can't expire between the check and the request reaching Zoho.
- If Zoho still answers `401` (e.g. the token was revoked early), the client refreshes and retries the request **once**. A second 401 is returned to the caller, so it can't loop. Retrying a POST here is safe because a 401 means Zoho rejected the request before running it.
- Concurrent requests for the same tenant share a single in-flight refresh; different tenants refresh independently and never wait on each other. After a burst of 401s, the refresh is skipped if another request already replaced the rejected token. This matters because Zoho allows only about 10 access tokens per 10 minutes, and going over locks you out (`ACCESS_DENIED` → 429).
- `OAUTH_SCOPE_MISMATCH` is not retried, since a new token wouldn't fix it.
- Nothing is hardcoded. If the refresh token itself is revoked, the API returns `401` asking that tenant to run `/oauth/login` again.

## Retry strategy

`ZohoHttpClient` has two separate, bounded retry paths:

| Failure | What happens | Max extra attempts |
|---|---|---|
| `401` (token expired or revoked) | Refresh the token, retry once | 1 |
| `429`, `5xx`, timeout, network drop | Wait and retry: 300 ms, then 900 ms (plus jitter, honouring `Retry-After`, capped at 5 s) | 2 |
| Other `4xx` (bad data, bad module, scope mismatch) | Not retried; the same request would fail the same way | 0 |

**POSTs are more careful.** A POST that timed out or got a `5xx` may already have created the lead in Zoho, so repeating it could create a duplicate. POSTs are only retried when Zoho definitely did not process them: a `429`, or a connection that never opened (`ECONNREFUSED`, DNS failure). GETs are safe to repeat and retry on every temporary failure.

Each retry logs a warning with the endpoint, the failure and the delay. Tokens are never logged.

## Duplicate prevention

`POST /leads` must not create two leads with the same email in the same tenant's CRM. A plain "search, then create" has two gaps, and each has its own guard:

| Gap | Guard |
|---|---|
| Two requests arrive at once; both searches find nothing, and both create | Creates for the same tenant + email are queued in memory and run one after another |
| Zoho's search index lags a few seconds behind inserts, so a retry right after a create finds nothing | The service remembers leads it created in the last 10 minutes and looks them up **by ID**, which doesn't depend on the search index |

If a remembered lead was deleted in Zoho since, the service falls back to a normal search and create. Everything is keyed by `tenant:email`, so the same email can exist once in each tenant's CRM.

These guards are per process. With several instances behind a load balancer you'd need a shared lock (e.g. Redis `SET NX` keyed by tenant + email) or a unique `Email` field configured in Zoho, which makes Zoho reject duplicates with `DUPLICATE_DATA`.

## Multi-tenant design

**What's implemented here (the demo):**

| Concern | How |
|---|---|
| Who is calling | `@TenantId()` resolves the tenant from `X-Tenant-Id` (or `?tenant=` on login) and validates it |
| Separate credentials | One token file per tenant: `tokens/{tenant}.json` |
| Separate data center | Each tenant's API calls go to the `api_domain` Zoho returned for that org (`.com`, `.eu`, `.in`, …), checked against Zoho's hosts before a token is sent there |
| Independent refresh | Per-tenant in-flight refresh; one tenant's expired token never blocks another |
| OAuth per tenant | The tenant rides on the server-side `state` record, so the callback always saves tokens for the tenant that started the flow |
| Isolated business logic | Duplicate prevention and caches are keyed by tenant; every service call takes the tenant explicitly |
| Traceability | Every error log line includes the tenant |

Tests prove the isolation: one tenant can't list or fetch another tenant's leads, the same email creates a lead in each tenant, and refreshes use each tenant's own refresh token.

**How this would extend to a real multi-tenant SaaS:**

- **Tenant identity from auth, not a header.** Here the caller names the tenant. In production the tenant comes from the caller's verified identity (a JWT claim, an API key looked up in the DB), so a customer can never just send someone else's tenant ID.
- **Encrypted token storage in a database, not files.** A `zoho_connections` table (`tenant_id` PK, `refresh_token_encrypted`, `access_token_encrypted`, `expires_at`, `api_domain`, `accounts_server`, `scopes`). Tokens are encrypted with envelope encryption (a per-row data key wrapped by a KMS key), so a DB dump alone doesn't leak working credentials. `TokenStoreService` is the only class that changes.
- **Tenant isolation at the query level.** Every query is scoped by `tenant_id`, enforced centrally (a repository that requires a tenant, or Postgres row-level security), never by remembering to add a `WHERE` in each place. Logs, caches, queues and locks are keyed by tenant too.
- **Why the client secret is shared but tokens are not.** The client ID and secret identify *our application* to Zoho; they are the same for every customer, live in a secrets manager, and let Zoho know which app is asking. Access and refresh tokens are the *customer's* grant: each one is bound to a single Zoho org and user, and holds the access that customer approved. Sharing a token would mean reading one customer's CRM with another customer's permission, so tokens are always stored and used per tenant. Rotating the client secret affects the app as a whole; revoking one customer's token affects only that customer.
- **Shared state for scale-out.** OAuth `state`, the per-email lock and the refresh lock move to Redis, so any instance can handle any tenant.
- **Per-tenant limits.** Zoho's API credits are per org, so rate limits and background sync concurrency should be per tenant as well as per IP.
- **Multi data center login.** Also read the `accounts-server` parameter Zoho adds to the callback and use it for that tenant's token refreshes (requires multi-DC to be enabled for the client in the Zoho API console).

## Security

- **Secrets**: loaded only from env via `@nestjs/config` and validated with Joi at startup. `.env` and `tokens/` are git-ignored; the token folder is created `0700` and each file is written `0600`.
- **No secret in logs or responses**: `ZohoApiError` carries only safe fields. Raw axios errors (whose config contains the client secret or `Authorization` header) are never logged or rethrown. Token-file parse errors aren't logged verbatim either, because Node's JSON error messages quote part of the file. The unit and e2e tests check that the secret never appears in thrown errors or response bodies.
- **Input**: DTO validation with `whitelist` + `forbidNonWhitelisted`, record IDs must be numeric, and emails are normalised to lower case. Tenant IDs use a strict charset, so `../` path tricks are rejected, and the token store double-checks that every file stays inside its folder.
- **Token destination**: an access token is only ever sent to a `https://www.zohoapis.*` host.
- **Rate limiting**: `@nestjs/throttler` allows 60 requests per minute per IP globally and 10 per minute on `/oauth/*`. It protects your Zoho API credit quota, not just the server. Behind a reverse proxy, enable Express `trust proxy` so limits apply per client rather than per proxy.
- **OAuth**: random, single-use, cookie-bound `state` (see above).

## Testing

```bash
npm test          # unit + e2e smoke tests (no Zoho account needed)
npm run test:cov  # with coverage
```

- Unit tests (`src/**/*.spec.ts`) cover: refresh timing and dedup under concurrency, per-tenant refresh and data-center selection, the bounded 401 retry, transient-error retries and backoff (and that unsafe POSTs aren't repeated), Zoho error-envelope parsing, OAuth state single-use and cookie binding, tenant ID validation, per-tenant token files, lead dedup under concurrent creates, the search-index lag, and pagination.
- E2E smoke tests (`test/app.e2e-spec.ts`) boot the real `AppModule` with a fake two-tenant Zoho and exercise every endpoint over HTTP: validation, tenant checks, cross-tenant isolation, error shapes, 201 vs 200 duplicate, 404, field metadata, rate limiting, and a check that no response leaks the secret.

## Notes / limitations

- **No authentication on `/leads`**: the assessment didn't ask for it, and the tenant header is trusted as-is. Before real use, derive the tenant from an API key or JWT (see *Multi-tenant design*).
- **Single instance**: token files, the OAuth `state` store and the dedup queue live in one process. For several instances, swap `TokenStoreService` for a DB and move state and locks to Redis. No other code needs to change.
- **Accounts server**: token refreshes use `ZOHO_ACCOUNTS_URL` for every tenant. Serving tenants from several Zoho data centers also needs the per-tenant `accounts-server` described above.
- **Pagination**: `GET /leads` returns one page at a time (`per_page` up to 200) with `moreRecords` and `nextPage`, and the caller walks the pages. Fetching everything in one request would spend one Zoho API call per 200 records, and a very slow request.

## AI usage disclosure

I used Claude (Claude Code) as a coding assistant for this project, the way I'd use a pairing partner: I made the technical decisions and directed the implementation, Claude executed and helped catch issues.

**Decisions and design I made:**
- Chose NestJS + TypeScript over a plainer Express setup, specifically because the module boundaries (auth / zoho / leads / tenancy) needed to be clean enough to explain and defend in an interview
- Specified the multi-tenant requirement (tenant-keyed token storage, a tenant ID on every endpoint) and reviewed and approved Claude's proposal for per-tenant data-center resolution from Zoho's own `api_domain` and independent per-tenant refresh locks, and can explain why each is needed — then decided how far to take it for a 2-4 hour assessment versus what belongs in the "how this would extend to production" write-up (a real DB, encrypted storage, tenant identity from auth instead of a header)
- Prioritized which of the assessment's "additional positive indicators" to build given the time budget (pagination, retry strategy, and field metadata were gaps I identified against the PDF and asked to have filled). Reviewed and approved Claude's proposal for the second duplicate-prevention guard, added after Claude found that Zoho's search index lags behind inserts
- Specified the retry requirement (bounded retries, never retry on 4xx). Reviewed and approved Claude's POST-safe retry rule — POSTs only retry when Zoho provably never ran them — and can explain why it avoids creating duplicate leads on a retried timeout
- Directed a senior-level architecture review against each of the 8 scored categories in the PDF (Part 6) and decided which findings to fix versus accept as reasonable trade-offs for the scope

**What Claude helped with:**
- Writing the boilerplate for the NestJS modules, DTOs, and the OAuth exchange/refresh code once I'd defined the approach
- Running the live smoke test against my own connected Zoho account, end to end, and reporting back the actual HTTP responses
- Catching a validation bug during testing (a missing `Email` returned a "too long" message instead of "required," because the max-length rule ran before the required check) — I reviewed the diagnosis, agreed with the fix, and had it applied and re-tested

**What I verified myself:**
- Created the Zoho account and OAuth client, and personally completed every OAuth login/consent step in the browser, since that can't be automated
- Read through `src/auth`, `src/zoho`, and `src/leads` end to end and can walk through the token-refresh timing, the duplicate-prevention strategy, and the multi-tenant isolation design without notes
- Confirmed the actual Record IDs and status codes in the Working demo section above by watching the live test run, not by trusting a summary
