import { IsString, IsNumber, IsEnum, IsOptional, IsDateString, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export type TransactionType = 'income' | 'expense' | 'transfer';
export type TransactionCategory =
  | 'food' | 'transport' | 'shopping' | 'entertainment' | 'health'
  | 'utilities' | 'housing' | 'education' | 'salary' | 'investment'
  | 'transfer' | 'other' | 'general';

export class CreateTransactionDto {
  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  amount: number;

  @IsEnum(['income', 'expense', 'transfer'])
  type: TransactionType;

  @IsString()
  @MinLength(1)
  category: TransactionCategory;

  @IsOptional()
  @IsEnum(['increase', 'decrease', 'none'])
  budget_impact?: string;

  @IsString()
  description: string;

  @IsOptional()
  @IsString()
  merchant?: string;

  @IsDateString()
  date: string;

  @IsOptional()
  @IsString()
  card_id?: string;
}

export class UpdateTransactionDto {
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  amount?: number;

  @IsOptional()
  @IsEnum(['income', 'expense', 'transfer'])
  type?: TransactionType;

  @IsOptional()
  @IsString()
  category?: TransactionCategory;

  @IsOptional()
  @IsEnum(['increase', 'decrease', 'none'])
  budget_impact?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  merchant?: string;

  @IsOptional()
  @IsDateString()
  date?: string;

  @IsOptional()
  @IsString()
  card_id?: string;
}

export class TransactionQueryDto {
  @IsOptional()
  @IsEnum(['income', 'expense', 'transfer'])
  type?: TransactionType;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  dateFrom?: string;

  @IsOptional()
  @IsString()
  dateTo?: string;

  @IsOptional()
  @IsString()
  cardId?: string;

  @IsOptional()
  @IsString()
  merchant?: string;

  @IsOptional()
  @Type(() => Number)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  limit?: number = 20;
}
