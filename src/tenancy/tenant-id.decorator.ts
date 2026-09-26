import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';
import { Request } from 'express';

export const TENANT_HEADER = 'x-tenant-id';

/**
 * Tenant IDs end up in file names (tokens/{tenant}.json) and log lines, so
 * they are restricted to a safe charset. That rules out "../" path tricks.
 * They are lower-cased so "Acme" and "acme" can't become two tenants that
 * share one file on case-insensitive file systems.
 */
const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export interface TenantRequest extends Request {
  tenantId?: string;
}

export function parseTenantId(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new BadRequestException(
      `Missing tenant. Send the "X-Tenant-Id" header (or "?tenant=" on /oauth/login).`,
    );
  }
  const tenantId = raw.trim().toLowerCase();
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new BadRequestException(
      'Invalid tenant id. Use 1-63 characters: letters, digits, "-" or "_".',
    );
  }
  return tenantId;
}

/**
 * Resolves the tenant for this request from the X-Tenant-Id header, falling
 * back to ?tenant= (needed for /oauth/login, which is opened in a browser
 * and can't carry custom headers).
 *
 * In a real SaaS the tenant would come from the caller's authenticated
 * identity (e.g. a JWT claim), never from a header the caller controls.
 */
export const TenantId = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<TenantRequest>();
    const tenantId = parseTenantId(
      req.headers[TENANT_HEADER] ?? req.query.tenant,
    );
    req.tenantId = tenantId; // picked up by the exception filter for logging
    return tenantId;
  },
);
