import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class InitiatePurchaseDto {
  @IsEmail()
  email: string;
}

export class CapturePurchaseDto {
  @IsString()
  @IsNotEmpty()
  order_id: string;

  @IsEmail()
  email: string;
}

export class ValidateLicenseDto {
  @IsString()
  @IsNotEmpty()
  license_key: string;
}

export class RedeemLicenseDto {
  @IsString()
  @IsNotEmpty()
  license_key: string;
}
