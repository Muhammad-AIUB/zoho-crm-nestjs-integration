# CLAUDE.md

Project notes for Claude working in this repo.

## Project

NestJS + TypeScript service that talks to the Zoho CRM v2 API:
- `src/auth` — OAuth login/callback, token storage (`tokens.json`), auto-refresh
- `src/zoho` — shared Zoho HTTP client
- `src/leads` — Leads list / get / create (with duplicate check by email)
- `src/common` — global exception filter

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
