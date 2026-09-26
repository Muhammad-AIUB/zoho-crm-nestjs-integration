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
└── main.ts
```

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
3. You are redirected to Zoho's consent screen (`scope=ZohoCRM.modules.ALL`, `access_type=offline`, `prompt=consent`). Log in and click **Accept**.
4. Zoho redirects back to `/oauth/callback?code=...`. The server exchanges the code for an access token and refresh token and saves them to `tokens.json`. You'll see:

```json
{
  "message": "Zoho account connected successfully.",
  "expiresAt": "2026-09-27T10:30:00.000Z"
}
```

Tokens are never returned in responses or written to logs.

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
  "page": 1,
  "perPage": 2,
  "moreRecords": true
}
```

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
- If Zoho still answers `401` (e.g. token revoked early), the client forces one refresh and retries the request once.
- Concurrent requests share a single in-flight refresh, so a burst of calls doesn't trigger several refreshes.
- Nothing is hardcoded — if the refresh token itself is revoked, the API returns `401` asking you to run `/oauth/login` again.

## Notes / limitations

- `tokens.json` storage suits a single instance. For multiple instances, replace `TokenStoreService` with a database or secret-store backed implementation — nothing else needs to change.
- The OAuth `state` values are kept in memory, so the login → callback round trip must hit the same instance.
