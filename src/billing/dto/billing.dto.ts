import { IsEmail, IsIn, IsNotEmpty, IsString } from 'class-validator';

export class InitiateSubscriptionDto {
  @IsIn(['monthly', 'yearly'])
  plan: 'monthly' | 'yearly';

  @IsEmail()
  email: string;
}

export class ActivateSubscriptionDto {
  @IsString()
  @IsNotEmpty()
  subscription_id: string;
}

export class ChangePlanDto {
  @IsIn(['monthly', 'yearly'])
  new_plan: 'monthly' | 'yearly';

  @IsEmail()
  email: string;
}

export class CompletePlanChangeDto {
  @IsString()
  @IsNotEmpty()
  subscription_id: string;
}

export class ReactivateSubscriptionDto {
  @IsEmail()
  email: string;
}
