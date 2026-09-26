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

/** One entry from GET /settings/fields?module=Leads (fields we use). */
export interface ZohoFieldMeta {
  api_name: string;
  field_label?: string;
  display_label?: string;
  data_type?: string;
  system_mandatory?: boolean;
  custom_field?: boolean;
  read_only?: boolean;
  length?: number;
}

/** Label → API name mapping we return from GET /leads/fields. */
export interface LeadField {
  label: string;
  apiName: string;
  dataType: string | null;
  required: boolean;
  custom: boolean;
  readOnly: boolean;
  maxLength: number | null;
}

export interface ZohoWriteResult {
  code: string;
  status: 'success' | 'error';
  message: string;
  details: Record<string, unknown> & { id?: string };
}
