# CLAUDE.md

## Project Snapshot
- Multi-tenant NestJS 10 + TypeScript service for the Zoho CRM v2 API (OAuth, Leads list/fields/get/create). No database.
- Flow: controller (`@TenantId()` + DTO) → service (business rules) → `ZohoHttpClient` → `TokenService` / `TokenStoreService` (`tokens/{tenant}.json`).
- Modules: `tenancy` (tenant id), `auth` (OAuth + tokens), `zoho` (HTTP client + `ZohoApiError`), `leads`, `common/filters`, `config`.

## Commands
- Install: `npm install`
- Dev: `npm run start:dev` · Start: `npm run start` · Prod: `npm run build && npm run start:prod`
- Build (also the type-check; no separate script): `npm run build`
- Test (unit `src/**/*.spec.ts` + e2e `test/app.e2e-spec.ts`, one Jest config): `npm test` · Coverage: `npm run test:cov`
- Lint: `npm run lint` · Format: `npm run format`
- DB migrate: none (no database)

## Architecture & Conventions
- Every service/client method takes `tenantId` as its first argument; in-memory keys are `${tenantId}:...`. Keep it that way so no call can use another tenant's token.
- Tenant comes only from `@TenantId()` (`src/tenancy/tenant-id.decorator.ts`): `X-Tenant-Id` header, or `?tenant=` on `/oauth/login`. Validated + lower-cased there. The OAuth callback gets the tenant from the server-side `state` record, never from the URL.
- Config: add every env var to `src/config/env.validation.ts` (Joi) and `.env.example`; read with `ConfigService.getOrThrow`.
- Errors: anything from Zoho becomes `ZohoApiError(status, zohoCode, message, endpoint, details?)`; `ZohoExceptionFilter` turns it into `{ statusCode, error, message, path, timestamp }` and one JSON log line (with tenant). Friendly per-code messages live in the filter.
- Zoho response shapes: 204 → client returns `null`; record-level errors sit in `data[0]`; lists carry `info.more_records`. Use Zoho API names (`Last_Name`, `Full_Name`) in DTOs/interfaces.
- DTO rule order matters: class-validator runs rules bottom-up and the pipe uses `stopAtFirstError`, so the "required" rule goes closest to the property (see `create-lead.dto.ts`).
- Routes: declare static routes (`/leads/fields`) before `/leads/:id`.
- Tests: construct classes directly with fakes cast `as unknown as X`; `jest.spyOn` on axios / `http.request` / `sleep`; e2e uses `overrideProvider(ZohoHttpClient)` and sets `process.env` before importing `AppModule`. No `jest.mock()` module mocks.
- Comments explain *why* (refresh buffer, dedup guards, retry safety), not what.

## Patterns We Do Not Use
- We do not call axios for CRM endpoints outside `ZohoHttpClient`. Only `TokenService` calls axios directly (accounts server, different auth).
- We do not rethrow or log raw axios errors, `err.config`, or `JSON.parse` messages for token files. Wrap in `ZohoApiError` / log a generic line — they contain the client secret or token fragments.
- We do not return or log access/refresh tokens or the client secret anywhere (the callback returns only `expiresAt`).
- We do not register global pipes/filters/guards in `main.ts`. Use `APP_PIPE` / `APP_FILTER` / `APP_GUARD` in `app.module.ts` so e2e tests get the same setup.
- We do not use `@nestjs/axios` (removed on purpose, plain axios is enough).
- We do not use `baseUrl` or path aliases. Relative imports only; `types` is listed explicitly in tsconfig (TypeScript 6 compatibility).
- We do not retry POSTs on 5xx or timeout (the lead may already exist). Only 429 / never-sent connection errors; GETs retry on any transient failure. Max 2 transient retries + 1 refresh-and-retry on 401.
- We do not refresh a token without the per-tenant in-flight lock in `TokenService` (Zoho allows ~10 refreshes / 10 min).
- We do not rely on Zoho search alone for duplicate checks (index lags inserts). Keep the per-tenant+email queue and the recent-creates cache in `LeadsService`.
- We do not send tokens to a host that isn't `https://www.zohoapis.*` (see `TokenService.getApiDomain`).
- We do not use `any`.

## Read First
- `src/zoho/zoho-http-client.service.ts` — the only CRM caller: token, data center, retries, error mapping.
- `src/auth/token.service.ts` — refresh timing, per-tenant locks, token-endpoint error mapping.
- `src/leads/leads.service.ts` — tenant threading and the two-guard duplicate prevention.
- `src/app.module.ts` + `test/app.e2e-spec.ts` — global wiring and how the app is tested end to end.

## Git Rules
- **Never add a `Co-Authored-By` line** (or any other AI attribution) to commit messages or PR descriptions.
- Small commits, one logical change each, plain human messages (e.g. `Add token service with auto refresh`, not `feat: implement comprehensive ...`).
- Remote: `https://github.com/Muhammad-AIUB/zoho-crm-nestjs-integration.git`, branch `main`.
- Secrets live only in `.env`; never commit `.env`, `tokens.json` or `tokens/`.

# Workflow

Never do the work yourself.
Always dispatch a sub-agent.
Don't always use Fable. Use Opus 5.5 for easier tasks.

# Model routing

- Fable 5.1: architecture, hard bugs, code review, anything
  where being wrong is expensive
- Opus 5.5: edits, tests, docs, refactors, the bulk of the work
- Haiku 4.5: lookups, file searches, summaries, one-line answers
- Pass `model` on every Agent call. No default routing.

# Delegation

- One sub-agent per task. Plan first, then dispatch.
- Run independent sub-agents in parallel, not one after another.
- Read the report, never the files. If a sub-agent did the work,
  trust its summary instead of re-reading everything it touched.
- Sub-agents return findings, not raw dumps.
