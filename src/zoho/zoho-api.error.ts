/**
 * Normalised error for anything that goes wrong while talking to Zoho.
 * Carries only safe fields — never the request config, headers or tokens.
 */
export class ZohoApiError extends Error {
  constructor(
    /** HTTP status we will return to our own client */
    public readonly status: number,
    /** Zoho's error code, e.g. INVALID_TOKEN, INVALID_MODULE, MANDATORY_NOT_FOUND */
    public readonly zohoCode: string,
    message: string,
    /** Zoho endpoint that failed, e.g. "GET /crm/v2/Leads" */
    public readonly endpoint: string,
    /** Extra non-sensitive details from Zoho (e.g. which field is missing) */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ZohoApiError';
  }
}
