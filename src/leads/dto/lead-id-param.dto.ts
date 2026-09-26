import { Matches } from 'class-validator';

export class LeadIdParamDto {
  /** Zoho record IDs are long numeric strings, e.g. 5725767000000524157 */
  @Matches(/^\d{1,25}$/, { message: 'id must be a numeric Zoho record ID' })
  id: string;
}
