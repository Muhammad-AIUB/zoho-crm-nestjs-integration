import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Field names match Zoho's API names so the DTO can be sent as-is.
 * Last_Name and Company are mandatory in Zoho's Leads layout; Email is
 * required here because we use it to detect duplicates.
 */
export class CreateLeadDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(40)
  First_Name?: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  Last_Name: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  Company: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(100)
  Email: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(/^\+?[0-9\s\-().]{5,30}$/, {
    message: 'Phone must contain only digits, spaces, and + - ( ) .',
  })
  Phone?: string;
}
