# Zoho CRM NestJS Integration

A small NestJS + TypeScript service that connects to Zoho CRM with OAuth 2.0 and exposes a clean REST API for Leads (list, get, create with duplicate check).

## Project structure

```
src/
├── auth/                     OAuth flow + token handling
│   ├── auth.controller.ts    GET /oauth/login, GET /oauth/callback
│   ├── auth.service.ts       builds the Zoho consent URL, CSRF state check
│   ├── token.service.ts      code exchange + automatic access token refresh
│   └── token-store.service.ts  reads/writes tokens.json
├── zoho/
│   ├── zoho-http-client.service.ts  shared Zoho CRM client (auth header, retry, error mapping)
│   └── zoho-api.error.ts     normalised Zoho error type
├── leads/                    GET /leads, GET /leads/:id, POST /leads
│   └── dto/                  class-validator DTOs
├── common/filters/
│   └── zoho-exception.filter.ts  global filter: clean JSON errors + context logging
├── config/env.validation.ts  fails fast if required env vars are missing
├── app.module.ts             wires modules, validation pipe, error filter, rate limiter
└── main.ts
test/app.e2e-spec.ts          HTTP-level smoke tests
```

## Architecture

Three modules, each with one job. Dependencies only point one way: `leads → zoho → auth`.

```
            HTTP client
                 │
   ┌─────────────┴───────────────┐
   │  ThrottlerGuard (per IP)     │   global: 60 req/min, /oauth: 10 req/min
   │  ValidationPipe (DTOs)       │   rejects bad input before any Zoho call
   └─────────────┬───────────────┘
                 │
  AuthController │ LeadsController        controllers: HTTP only, no logic
                 │        │
   AuthService   │   LeadsService         business rules (state check, dedup)
   TokenService ◄┼── ZohoHttpClient       single place that talks to the CRM API
   TokenStore    │        │
   (tokens.json) │        ▼
                 │  www.zohoapis.com/crm/v2
                 ▼
     accounts.zoho.com/oauth/v2
                 │
   ZohoExceptionFilter (global)           every error → one JSON shape + one log line
```

A `POST /leads` request, end to end:

1. `ThrottlerGuard` checks the caller's rate limit.
2. `ValidationPipe` validates the body against `CreateLeadDto` (required fields, email format, no unknown fields). Invalid input stops here, and Zoho is never called.
3. `LeadsService.create` queues the request behind any in-flight create for the same email (see *Duplicate prevention*).
4. `ZohoHttpClient` asks `TokenService` for a valid token (refreshing it if needed), calls `GET /Leads/search?email=`, then `POST /Leads`.
5. Any failure becomes a `ZohoApiError`, which the global filter turns into clean JSON and a structured log line.

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
| `ZOHO_ACCOUNTS_URL` | Zoho accounts server for your data center | `https://accounts.zoho.com` |
| `ZOHO_API_DOMAIN` | Zoho API domain for your data center | `https://www.zohoapis.com` |
| `TOKEN_STORE_PATH` | Where tokens are saved (optional) | `tokens.json` |

If your Zoho account is in another data center, use the matching domains (e.g. `accounts.zoho.eu` / `www.zohoapis.eu`, `accounts.zoho.in` / `www.zohoapis.in`).

The app validates these on startup and refuses to start if a required one is missing. `.env` and `tokens.json` are git-ignored.

## Running

```bash
npm run start:dev     # watch mode
# or
npm run build && npm run start:prod
```

## Step 1 — connect Zoho (OAuth flow)

This must be done once before calling any `/leads` endpoint.

1. Start the server.
2. Open **http://localhost:3000/oauth/login** in a browser.
3. You are redirected to Zoho's consent screen (`scope=ZohoCRM.modules.ALL,ZohoCRM.settings.fields.READ`, `access_type=offline`, `prompt=consent`). Log in and click **Accept**.
   - `ZohoCRM.modules.ALL`: read, create and search records.
   - `ZohoCRM.settings.fields.READ`: read field metadata for `GET /leads/fields`. A token granted without it gets `401 OAUTH_SCOPE_MISMATCH` on that endpoint; reconnecting fixes it.
4. Zoho redirects back to `/oauth/callback?code=...&state=...`. The server checks the `state` (see below), exchanges the code for an access token and refresh token, and saves them to `tokens.json`. You'll see:

```json
{
  "message": "Zoho account connected successfully.",
  "expiresAt": "2026-09-27T10:30:00.000Z"
}
```

Tokens are never returned in responses or written to logs.

**How the `state` check works (CSRF protection, RFC 6749 §10.12).** `/oauth/login` generates 128 random bits with `crypto.randomBytes`, stores them server-side for 10 minutes, and also sets them in an `HttpOnly`, `SameSite=Lax` cookie. The callback only accepts the code if the `state` in the URL matches the cookie, matches a state the server issued, and hasn't been used yet. It is deleted on first use, so it can't be replayed. The cookie check stops login CSRF, where an attacker completes consent with their own Zoho account and tricks another browser into opening the callback link. Start and finish the flow in the same browser.

## Endpoints

### `GET /leads`

Returns leads with ID, name, email and phone. Optional query params: `page` (default 1), `per_page` (default 20, max 200).

```bash
curl "http://localhost:3000/leads?page=1&per_page=2"
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
curl http://localhost:3000/leads/fields
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

**Why it matters:** the API ignores labels. Sending `"Customer Type": "Retail"` does nothing; it has to be `"Customer_Type": "Retail"`. Admins can rename labels at any time, but API names stay fixed, so integrations should always use API names. This endpoint lets you look them up (including custom fields and which ones are required) instead of guessing. You can also find them in Zoho under *Setup → Developer Space → APIs → API Names*.

### `GET /leads/:id`

```bash
curl http://localhost:3000/leads/5725767000000524157
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

Not found → `404`:

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
  -H "Content-Type: application/json" \
  -d '{
    "First_Name": "John",
    "Last_Name": "Doe",
    "Company": "Acme Inc",
    "Email": "john.doe@acme.com",
    "Phone": "+1 555 0100"
  }'
```

Before creating, the service searches Zoho Leads by email (`GET /crm/v2/Leads/search?email=...`).

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
  "message": ["Last_Name should not be empty", "Email must be an email"],
  "path": "/leads",
  "timestamp": "2026-09-27T09:30:00.000Z"
}
```

## Error handling

A global exception filter turns every Zoho failure into the same JSON shape, with a readable message instead of the raw Zoho payload:

| Situation | Status | `error` | Example message |
|---|---|---|---|
| Not connected yet | 401 | `NOT_AUTHORIZED` | No Zoho tokens found. Visit /oauth/login to connect your Zoho account. |
| Token invalid and refresh failed | 401 | `INVALID_TOKEN` | Zoho access token is invalid or expired and could not be refreshed. Visit /oauth/login to reconnect. |
| Bad module | 400 | `INVALID_MODULE` | The requested Zoho CRM module does not exist or is not supported. |
| Missing field | 400 | `MANDATORY_NOT_FOUND` | Required field "Last_Name" is missing. |
| Bad data / record ID | 400 | `INVALID_DATA` | Invalid value for field "Email". |
| Caller over the rate limit | 429 | `TOO_MANY_REQUESTS` | Too many requests. Please wait a minute and try again. |
| Too many token refreshes | 429 | `ACCESS_DENIED` | Zoho is rate-limiting token requests. Please retry in a few minutes. |
| Wrong client ID/secret/redirect URI in `.env` | 500 | `INVALID_CLIENT` | Zoho rejected this server's OAuth client settings. Check ZOHO_CLIENT_ID, ... |
| Zoho down / 5xx | 502 | `ZOHO_UNREACHABLE` | Could not reach the Zoho CRM API. Please try again. |

Each error is logged as one JSON line with the route, Zoho endpoint, Zoho error code, status and timestamp, for example:

```
ERROR [ExceptionFilter] {"timestamp":"2026-09-27T09:30:00.000Z","route":"POST /leads","zohoEndpoint":"POST /crm/v2/Leads","zohoCode":"MANDATORY_NOT_FOUND","status":400,"message":"required field not found","details":{"api_name":"Last_Name"}}
```

The logged error object is built by hand from safe fields, so the client secret, access token and refresh token never end up in logs (raw axios errors, which contain request headers, are never logged or rethrown).

## How token refresh works

- After the OAuth callback, `tokens.json` holds the `access_token`, `refresh_token` and an `expires_at` timestamp (Zoho access tokens last 1 hour).
- Every Zoho call goes through `ZohoHttpClient`, which asks `TokenService.getAccessToken()` for a token.
- If the token expires within the next 60 seconds, `TokenService` calls `POST {ZOHO_ACCOUNTS_URL}/oauth/v2/token` with `grant_type=refresh_token`, saves the new access token (keeping the existing refresh token, since Zoho doesn't issue a new one) and returns it.
- Why 60 seconds early: `expires_at` is computed when the response arrives, so it's already a little late. The buffer also means a token can't expire between the check and the request reaching Zoho.
- If Zoho still answers `401` (e.g. the token was revoked early), the client refreshes and retries the request **once**. A second 401 is returned to the caller, so it can't loop. Retrying a POST here is safe because a 401 means Zoho rejected the request before running it.
- Concurrent requests share a single in-flight refresh. After a burst of 401s, the refresh is skipped if another request already replaced the rejected token. This matters because Zoho allows only about 10 access tokens per 10 minutes, and going over locks you out (`ACCESS_DENIED` → 429).
- `OAUTH_SCOPE_MISMATCH` is not retried, since a new token wouldn't fix it.
- Nothing is hardcoded. If the refresh token itself is revoked, the API returns `401` asking you to run `/oauth/login` again.

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

`POST /leads` must not create two leads with the same email. A plain "search, then create" has two gaps, and each has its own guard:

| Gap | Guard |
|---|---|
| Two requests arrive at once; both searches find nothing, and both create | Creates for the same email are queued in memory and run one after another |
| Zoho's search index lags a few seconds behind inserts, so a retry right after a create finds nothing | The service remembers leads it created in the last 10 minutes and looks them up **by ID**, which doesn't depend on the search index |

If a remembered lead was deleted in Zoho since, the service falls back to a normal search and create.

These guards are per process. With several instances behind a load balancer you'd need a shared lock (e.g. Redis `SET NX` keyed by email) or a unique `Email` field configured in Zoho, which makes Zoho reject duplicates with `DUPLICATE_DATA`.

## Security

- **Secrets**: loaded only from env via `@nestjs/config` and validated with Joi at startup. `.env` and `tokens.json` are git-ignored, and `tokens.json` is written with `0600` permissions.
- **No secret in logs or responses**: `ZohoApiError` carries only safe fields. Raw axios errors (whose config contains the client secret or `Authorization` header) are never logged or rethrown. Token-file parse errors aren't logged verbatim either, because Node's JSON error messages quote part of the file. The unit and e2e tests check that the secret never appears in thrown errors or response bodies.
- **Input**: DTO validation with `whitelist` + `forbidNonWhitelisted`, record IDs must be numeric, and emails are normalised to lower case.
- **Rate limiting**: `@nestjs/throttler` allows 60 requests per minute per IP globally and 10 per minute on `/oauth/*`. It protects your Zoho API credit quota, not just the server. Behind a reverse proxy, enable Express `trust proxy` so limits apply per client rather than per proxy.
- **OAuth**: random, single-use, cookie-bound `state` (see above).

## Testing

```bash
npm test          # unit + e2e smoke tests (no Zoho account needed)
npm run test:cov  # with coverage
```

- Unit tests (`src/**/*.spec.ts`) cover: refresh timing and dedup under concurrency, the bounded 401 retry, Zoho error-envelope parsing, OAuth state single-use and cookie binding, lead dedup under concurrent creates, and the search-index lag.
- E2E smoke tests (`test/app.e2e-spec.ts`) boot the real `AppModule` with a fake Zoho client and exercise every endpoint over HTTP: validation, error shapes, 201 vs 200 duplicate, 404, rate limiting, and a check that no response leaks the secret.

## Notes / limitations

- **No authentication on `/leads`**: the assessment didn't ask for it. Anyone who can reach the server can read and create leads. Before real use, put it behind an API key or JWT guard, or a private network.
- **Single instance**: `tokens.json`, the OAuth `state` store, and the dedup queue all live in one process. For several instances, swap `TokenStoreService` for a DB or secret store and move state and locks to Redis. No other code needs to change.
- **One Zoho data center**: `ZOHO_ACCOUNTS_URL` and `ZOHO_API_DOMAIN` are fixed by config. A multi-tenant app would read the `accounts-server` callback parameter and the `api_domain` from the token response instead.
- **Pagination**: `GET /leads` returns one page at a time (`per_page` up to 200) with `moreRecords` and `nextPage`, and the caller walks the pages. Fetching everything in one request would spend one Zoho API call per 200 records, and a very slow request.
