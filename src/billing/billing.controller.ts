import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthGuard } from '../common/guards/auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { SkipBillingCheck } from '../common/decorators/skip-billing.decorator';
import { BillingService } from './billing.service';
import {
  ActivateSubscriptionDto,
  ChangePlanDto,
  CompletePlanChangeDto,
  InitiateSubscriptionDto,
  ReactivateSubscriptionDto,
} from './dto/billing.dto';
import type { User } from '@supabase/supabase-js';

@Controller('billing')
@UseGuards(AuthGuard)
@SkipBillingCheck()
export class BillingController {
  private readonly logger = new Logger(BillingController.name);

  constructor(private readonly billing: BillingService) {}

  // ─── Subscription creation ─────────────────────────────────────────────────

  @Post('subscribe')
  @HttpCode(200)
  async initiate(
    @Body() dto: InitiateSubscriptionDto,
    @CurrentUser() user: User,
  ) {
    const { subscriptionId } = await this.billing.initiateSubscription(
      user.id,
      dto.plan,
      dto.email,
    );
    return { subscriptionId };
  }

  @Post('activate')
  @HttpCode(200)
  async activate(
    @Body() dto: ActivateSubscriptionDto,
    @CurrentUser() user: User,
  ) {
    const subscription = await this.billing.activateSubscription(
      user.id,
      dto.subscription_id,
    );
    return { subscription };
  }

  // ─── Subscription info ─────────────────────────────────────────────────────

  @Get('status')
  async getStatus(@CurrentUser() user: User) {
    const subscription = await this.billing.getSubscription(user.id);
    const access = await this.billing.checkAccess(user.id);
    return { subscription, access };
  }

  @Get('payment-history')
  async getPaymentHistory(@CurrentUser() user: User) {
    const history = await this.billing.getPaymentHistory(user.id);
    return { history };
  }

  // ─── Plan changes ──────────────────────────────────────────────────────────

  @Post('change-plan')
  @HttpCode(200)
  async changePlan(
    @Body() dto: ChangePlanDto,
    @CurrentUser() user: User,
  ) {
    const result = await this.billing.initiatePlanChange(
      user.id,
      dto.new_plan,
      dto.email,
    );
    return result;
  }

  @Post('complete-plan-change')
  @HttpCode(200)
  async completePlanChange(
    @Body() dto: CompletePlanChangeDto,
    @CurrentUser() user: User,
  ) {
    const subscription = await this.billing.completePlanChange(
      user.id,
      dto.subscription_id,
    );
    return { subscription };
  }

  // ─── Cancellation ──────────────────────────────────────────────────────────

  @Post('reactivate')
  @HttpCode(200)
  async reactivate(
    @Body() dto: ReactivateSubscriptionDto,
    @CurrentUser() user: User,
  ) {
    const result = await this.billing.reactivateSubscription(user.id, dto.email);
    return result;
  }

  @Post('cancel')
  @HttpCode(200)
  async cancel(@CurrentUser() user: User) {
    const subscription = await this.billing.cancelSubscription(user.id);
    return { subscription };
  }

  // ─── Payment method ────────────────────────────────────────────────────────

  @Get('payment-method-update-url')
  async getPaymentMethodUpdateUrl(@CurrentUser() user: User) {
    return this.billing.getPaymentMethodUpdateUrl(user.id);
  }

  // ─── Vercel cron trigger (public — authenticated by CRON_SECRET) ──────────

  @Get('cron/process-grace-periods')
  @HttpCode(200)
  @Public()
  @SkipThrottle()
  async cronProcessGracePeriods(
    @Headers('authorization') auth: string,
  ) {
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      throw new ForbiddenException('Invalid cron secret');
    }
    await this.billing.processGracePeriodExpirations();
    return { ok: true };
  }

  // ─── PayPal webhook (public — no JWT, no billing check) ───────────────────

  @Post('webhook')
  @HttpCode(200)
  @Public()
  @SkipThrottle()
  async handleWebhook(
    @Headers() headers: Record<string, string>,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const rawBody = req.rawBody?.toString() ?? JSON.stringify(req.body);

    const isValid = await this.billing['paypal'].verifyWebhookSignature(
      headers,
      rawBody,
    );

    if (!isValid) {
      this.logger.warn('PayPal webhook signature verification failed');
      throw new ForbiddenException('Invalid webhook signature');
    }

    await this.billing.handleWebhookEvent(req.body as {
      event_type: string;
      resource: Record<string, unknown>;
    });

    return { received: true };
  }
}
