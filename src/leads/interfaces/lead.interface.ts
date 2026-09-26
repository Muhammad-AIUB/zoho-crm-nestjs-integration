/** The trimmed-down lead we return to our own API clients. */
export interface Lead {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

/** The subset of Zoho's Lead record we read. */
export interface ZohoLeadRecord {
  id: string;
  Full_Name?: string | null;
  First_Name?: string | null;
  Last_Name?: string | null;
  Email?: string | null;
  Phone?: string | null;
}

export interface ZohoListResponse<T> {
  data: T[];
  info?: {
    page: number;
    per_page: number;
    count: number;
    more_records: boolean;
  };
}

export interface ZohoWriteResult {
  code: string;
  status: 'success' | 'error';
  message: string;
  details: Record<string, unknown> & { id?: string };
}
