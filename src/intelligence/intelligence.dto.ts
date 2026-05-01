import { IsString, IsNumber, IsOptional, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class SimulateDto {
  @IsNumber()
  @Min(0.01)
  @Type(() => Number)
  amount: number;

  @IsString()
  category: string;

  @IsOptional()
  @IsString()
  description?: string;
}

export class ProjectionsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @Min(7)
  @Max(90)
  days?: number = 30;
}

export class CategorySuggestDto {
  @IsString()
  merchant: string;
}
