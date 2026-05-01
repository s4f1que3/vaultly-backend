import { IsString, IsNumber, IsOptional, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateSavingsPotDto {
  @IsString()
  @MinLength(2)
  name: string;

  @IsString()
  emoji: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  amount?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateSavingsPotDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsString()
  emoji?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  amount?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}
