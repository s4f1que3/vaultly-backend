import { IsString, IsNumber, IsOptional, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateBudgetDto {
  @IsString()
  category: string;

  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  limit_amount: number;

  @IsOptional()
  @IsString()
  period?: string;

  @IsNumber()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  alert_threshold: number;
}

export class UpdateBudgetDto {
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  limit_amount?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  alert_threshold?: number;
}
