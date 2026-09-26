/** Shape of tokens.json on disk. */
export interface StoredTokens {
  access_token: string;
  refresh_token: string;
  /** Epoch millis when the access token stops being valid */
  expires_at: number;
  api_domain?: string;
  token_type?: string;
}

/** Raw response from POST {accounts}/oauth/v2/token */
export interface ZohoTokenResponse {
  access_token?: string;
  refresh_token?: string;
  api_domain?: string;
  token_type?: string;
  /** Seconds until expiry */
  expires_in?: number;
  /** Zoho returns HTTP 200 with an `error` field on failure */
  error?: string;
}
