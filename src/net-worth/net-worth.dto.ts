import { IsString, IsNumber, IsEnum, IsOptional, IsDateString, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateLiabilityDto {
  @IsString() name: string;
  @IsEnum(['mortgage', 'auto_loan', 'student_loan', 'credit_card', 'personal_loan', 'other']) type: string;

  @IsNumber() @Min(0) @Type(() => Number) balance: number;
  @IsNumber() @Min(0) @Type(() => Number) interest_rate: number;
  @IsNumber() @Min(0) @Type(() => Number) minimum_payment: number;

  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) original_amount?: number;
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) down_payment?: number;
  @IsOptional() @IsNumber() @Min(1) @Max(50) @Type(() => Number) term_years?: number;
  @IsOptional() @IsDateString() start_date?: string;
  @IsOptional() @IsString() budget_category?: string;
}

export class UpdateLiabilityDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsEnum(['mortgage', 'auto_loan', 'student_loan', 'credit_card', 'personal_loan', 'other']) type?: string;
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) balance?: number;
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) interest_rate?: number;
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) minimum_payment?: number;
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) original_amount?: number;
  @IsOptional() @IsNumber() @Min(0) @Type(() => Number) down_payment?: number;
  @IsOptional() @IsNumber() @Min(1) @Max(50) @Type(() => Number) term_years?: number;
  @IsOptional() @IsDateString() start_date?: string;
  @IsOptional() @IsString() budget_category?: string;
}
