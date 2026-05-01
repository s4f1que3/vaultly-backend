import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import type { User } from '@supabase/supabase-js';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { SKIP_BILLING_KEY } from '../../common/decorators/skip-billing.decorator';
import { BillingService } from '../billing.service';

@Injectable()
export class SubscriptionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly billing: BillingService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Skip for @Public() routes
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // Skip for @SkipBillingCheck() routes (e.g., /billing/*, /auth/*)
    const skipBilling = this.reflector.getAllAndOverride<boolean>(SKIP_BILLING_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skipBilling) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const user = req['user'] as User | undefined;

    // No user means AuthGuard will reject this — let it handle the 401
    if (!user) return true;

    const access = await this.billing.checkAccess(user.id);

    if (access.hasAccess) return true;

    throw new HttpException(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        error: 'Payment Required',
        message: access.message ?? 'Active subscription required',
        subscriptionStatus: access.status,
        gracePeriodEnd: access.gracePeriodEnd,
        periodEnd: access.periodEnd,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
