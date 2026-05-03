import { IsString, IsNumber, IsEnum, IsOptional, IsBoolean, Min, Length } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateCardDto {
  @IsString()
  card_holder: string;

  @IsString()
  @Length(4, 4)
  card_number: string;

  @IsString()
  expiry_month: string;

  @IsString()
  @Length(4, 4)
  expiry_year: string;

  @IsEnum(['visa', 'mastercard', 'amex'])
  card_type: string;

  @IsEnum(['credit', 'debit'])
  card_kind: string;

  @IsEnum(['green', 'dark', 'brown', 'purple', 'gold'])
  theme: string;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  balance: number;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  credit_limit: number;
}

export class UpdateCardDto {
  @IsOptional()
  @IsString()
  card_holder?: string;

  @IsOptional()
  @IsEnum(['green', 'dark', 'brown', 'purple', 'gold'])
  theme?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  balance?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  credit_limit?: number;

  @IsOptional()
  @IsString()
  expiry_month?: string;

  @IsOptional()
  @IsString()
  @Length(4, 4)
  expiry_year?: string;
}
