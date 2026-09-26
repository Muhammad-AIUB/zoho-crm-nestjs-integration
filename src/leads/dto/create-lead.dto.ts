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
 * Last_Name is mandatory in Zoho, Company is required by most Leads
 * layouts, and Email is required here because we use it to detect
 * duplicates.
 *
 * Rule order matters: class-validator runs a property's rules bottom-up,
 * and the ValidationPipe uses stopAtFirstError. So the "required" rule sits
 * closest to the property (runs first), then the type check, then length.
 * Otherwise a missing field is reported as "must be shorter than N".
 */
export class CreateLeadDto {
  @IsOptional()
  @Transform(trim)
  @MaxLength(40)
  @IsString()
  First_Name?: string;

  @Transform(trim)
  @MaxLength(80)
  @IsString()
  @IsNotEmpty({ message: 'Last_Name is required' })
  Last_Name: string;

  @Transform(trim)
  @MaxLength(200)
  @IsString()
  @IsNotEmpty({ message: 'Company is required' })
  Company: string;

  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @MaxLength(100)
  @IsEmail({}, { message: 'Email must be a valid email address' })
  @IsNotEmpty({ message: 'Email is required' })
  Email: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(/^\+?[0-9\s\-().]{5,30}$/, {
    message: 'Phone must contain only digits, spaces, and + - ( ) .',
  })
  Phone?: string;
}
