# CLAUDE.md

Project notes for Claude working in this repo.

## Project

Multi-tenant NestJS + TypeScript service that talks to the Zoho CRM v2 API:
- `src/tenancy` — `@TenantId()` decorator: tenant from `X-Tenant-Id` (or `?tenant=` on /oauth/login)
- `src/auth` — OAuth login/callback, per-tenant token files (`tokens/{tenant}.json`), auto-refresh
- `src/zoho` — shared Zoho HTTP client (per-tenant token + data center, retries)
- `src/leads` — Leads list / fields / get / create (duplicate check per tenant + email)
- `src/common` — global exception filter

Every service method takes `tenantId` explicitly; keep it that way so no call can use another tenant's token.

## Git rules

- **Never add a `Co-Authored-By` line** (or any other AI attribution) to commit messages or PR descriptions.
- Commit small pieces of work as you go — one logical change per commit, not one big commit at the end.
- Write commit messages like a human developer would: short, plain, and clear about what changed.
  - Good: `Add token service with auto refresh`, `Validate lead payload before sending to Zoho`
  - Bad: `feat: implement comprehensive OAuth2 token management solution`
- Remote: `https://github.com/Muhammad-AIUB/zoho-crm-nestjs-integration.git`, branch `main`.

## Secrets

- Real credentials live only in `.env` (gitignored). Never commit `.env` or `tokens.json`.
- Never log or return the client secret, access token, or refresh token.

## Commands

- `npm run start:dev` — run locally
- `npm run build` — typecheck and compile
- `npm run lint` — lint
- `npm test` — unit + e2e smoke tests (no Zoho account needed)
