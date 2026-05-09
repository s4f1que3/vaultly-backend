import { IsString, IsNumber, IsEnum, IsOptional, Min } from 'class-validator';

export class CreateLiabilityDto {
  @IsString() name: string;
  @IsEnum(['mortgage', 'auto_loan', 'student_loan', 'credit_card', 'personal_loan', 'other']) type: string;
  @IsNumber() @Min(0) balance: number;
  @IsNumber() @Min(0) interest_rate: number;
  @IsNumber() @Min(0) minimum_payment: number;
}

export class UpdateLiabilityDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsNumber() @Min(0) balance?: number;
  @IsOptional() @IsNumber() @Min(0) interest_rate?: number;
  @IsOptional() @IsNumber() @Min(0) minimum_payment?: number;
}
