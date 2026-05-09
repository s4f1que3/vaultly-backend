import { IsString, IsNumber, IsEnum, IsOptional, IsBoolean, IsDateString, Min, Max } from 'class-validator';

export class CreateRecurringTransactionDto {
  @IsString() name: string;
  @IsNumber() @Min(0.01) amount: number;
  @IsEnum(['income', 'expense', 'transfer']) type: string;
  @IsString() category: string;
  @IsOptional() @IsString() card_id?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() merchant?: string;
  @IsEnum(['daily', 'weekly', 'biweekly', 'monthly', 'yearly']) frequency: string;
  @IsOptional() @IsNumber() @Min(1) @Max(31) day_of_month?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(6) day_of_week?: number;
  @IsDateString() start_date: string;
  @IsOptional() @IsDateString() end_date?: string;
  // Linked transaction (secondary entry created on the same date)
  @IsOptional() @IsString() linked_category?: string;
  @IsOptional() @IsEnum(['income', 'expense', 'transfer']) linked_type?: string;
  @IsOptional() @IsEnum(['increase', 'decrease', 'none']) linked_budget_impact?: string;
}

export class UpdateRecurringTransactionDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsNumber() @Min(0.01) amount?: number;
  @IsOptional() @IsEnum(['income', 'expense', 'transfer']) type?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() card_id?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() merchant?: string;
  @IsOptional() @IsEnum(['daily', 'weekly', 'biweekly', 'monthly', 'yearly']) frequency?: string;
  @IsOptional() @IsNumber() @Min(1) @Max(31) day_of_month?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(6) day_of_week?: number;
  @IsOptional() @IsDateString() start_date?: string;
  @IsOptional() @IsDateString() end_date?: string;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @IsString() linked_category?: string;
  @IsOptional() @IsEnum(['income', 'expense', 'transfer']) linked_type?: string;
  @IsOptional() @IsEnum(['increase', 'decrease', 'none']) linked_budget_impact?: string;
}
