import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../common/supabase.service';
import { PaypalService } from './paypal.service';
import { AlertService } from '../common/alert.service';

export type BillingPlan = 'monthly' | 'yearly';
export type SubscriptionStatus =
  | 'pending'
  | 'active'
  | 'past_due'
  | 'frozen'
  | 'cancelled';

export interface AppSubscription {
  id: string;
  user_id: string;
  plan: BillingPlan;
  status: SubscriptionStatus;
  billing_day: number;
  current_period_start: string;
  current_period_end: string;
  next_billing_date: string;
  grace_period_end: string | null;
  paypal_subscription_id: string | null;
  pending_paypal_subscription_id: string | null;
  pending_plan: BillingPlan | null;
  payment_method_last4: string | null;
  payment_method_brand: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AccessCheck {
  hasAccess: boolean;
  status: string;
  message?: string;
  gracePeriodEnd?: string;
  periodEnd?: string;
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly paypal: PaypalService,
    private readonly alert: AlertService,
  ) {}

  // ─── Subscription creation ─────────────────────────────────────────────────

  async initiateSubscription(
    userId: string,
    plan: BillingPlan,
    userEmail: string,
  ): Promise<{ subscriptionId: string }> {
    const existing = await this.getSubscription(userId);
    if (existing?.status === 'active') {
      throw new BadRequestException('Already have an active subscription');
    }

    const now = new Date();
    // PayPal requires start_time to be in the future
    const startTime = new Date(now.getTime() + 5 * 60 * 1000);
    const billingDay = now.getDate();
    const periodEnd = this.calcPeriodEnd(now, plan);

    const { subscriptionId } = await this.paypal.createSubscription(
      plan,
      userEmail,
      startTime,
    );

    await this.supabase.db.from('app_subscriptions').upsert(
      {
        user_id: userId,
        plan,
        status: 'pending',
        billing_day: billingDay,
        current_period_start: now.toISOString(),
        current_period_end: periodEnd.toISOString(),
        next_billing_date: periodEnd.toISOString(),
        paypal_subscription_id: subscriptionId,
        pending_paypal_subscription_id: null,
        pending_plan: null,
        payment_method_last4: null,
        payment_method_brand: null,
        cancelled_at: null,
        grace_period_end: null,
        updated_at: now.toISOString(),
      },
      { onConflict: 'user_id' },
    );

    return { subscriptionId };
  }

  async activateSubscription(
    userId: string,
    paypalSubscriptionId: string,
  ): Promise<AppSubscription> {
    const paypalSub = await this.paypal.getSubscription(paypalSubscriptionId);

    if (paypalSub.status !== 'ACTIVE' && paypalSub.status !== 'APPROVED') {
      throw new BadRequestException(
        `PayPal subscription status is ${paypalSub.status}, expected ACTIVE`,
      );
    }

    const { last4, brand } = this.extractPaymentMethod(paypalSub);

    const { error } = await this.supabase.db
      .from('app_subscriptions')
      .update({
        status: 'active',
        payment_method_last4: last4,
        payment_method_brand: brand,
        cancelled_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .eq('paypal_subscription_id', paypalSubscriptionId);

    if (error) throw new BadRequestException('Failed to activate subscription');

    return this.getSubscriptionOrThrow(userId);
  }

  // ─── Subscription query ────────────────────────────────────────────────────

  async getSubscription(userId: string): Promise<AppSubscription | null> {
    const { data } = await this.supabase.db
      .from('app_subscriptions')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    return data as AppSubscription | null;
  }

  private async getSubscriptionOrThrow(userId: string): Promise<AppSubscription> {
    const sub = await this.getSubscription(userId);
    if (!sub) throw new NotFoundException('Subscription not found');
    return sub;
  }

  async checkAccess(userId: string): Promise<AccessCheck> {
    // Licensed users always have access — no subscription required
    const { data: license } = await this.supabase.db
      .from('licenses')
      .select('id')
      .eq('used_by', userId)
      .eq('status', 'used')
      .maybeSingle();
    if (license) return { hasAccess: true, status: 'licensed' };

    const sub = await this.getSubscription(userId);

    if (!sub) {
      return { hasAccess: false, status: 'none', message: 'No subscription found' };
    }

    const now = new Date();

    switch (sub.status) {
      case 'active':
        return { hasAccess: true, status: 'active' };

      case 'past_due': {
        const graceEnd = sub.grace_period_end ? new Date(sub.grace_period_end) : null;
        if (graceEnd && graceEnd > now) {
          return {
            hasAccess: true,
            status: 'past_due',
            message: 'Payment failed — please update your payment method',
            gracePeriodEnd: sub.grace_period_end!,
          };
        }
        return {
          hasAccess: false,
          status: 'frozen',
          message: 'Account frozen — grace period expired',
        };
      }

      case 'frozen':
        return {
          hasAccess: false,
          status: 'frozen',
          message: 'Account frozen due to unpaid subscription',
        };

      case 'cancelled': {
        const periodEnd = new Date(sub.current_period_end);
        if (periodEnd > now) {
          return {
            hasAccess: true,
            status: 'cancelled',
            message: 'Subscription cancelled — access until period end',
            periodEnd: sub.current_period_end,
          };
        }
        return {
          hasAccess: false,
          status: 'expired',
          message: 'Subscription has expired',
        };
      }

      case 'pending':
        return {
          hasAccess: false,
          status: 'pending',
          message: 'Subscription awaiting PayPal approval',
        };

      default:
        return { hasAccess: false, status: 'unknown', message: 'Unknown subscription state' };
    }
  }

  // ─── Plan change ───────────────────────────────────────────────────────────

  async initiatePlanChange(
    userId: string,
    newPlan: BillingPlan,
    userEmail: string,
  ): Promise<{ approveUrl: string; immediate: boolean; effectiveDate?: string }> {
    const sub = await this.getSubscriptionOrThrow(userId);

    if (sub.status !== 'active') {
      throw new BadRequestException('Can only change plan on an active subscription');
    }
    if (sub.plan === newPlan) {
      throw new BadRequestException(`Already on the ${newPlan} plan`);
    }

    let startTime: Date;
    let immediate: boolean;

    if (newPlan === 'yearly') {
      // Monthly → Yearly: charge immediately — 5 min buffer for PayPal
      startTime = new Date(Date.now() + 5 * 60 * 1000);
      immediate = true;
    } else {
      // Yearly → Monthly: no charge until current year ends
      startTime = new Date(sub.current_period_end);
      immediate = false;
    }

    const { subscriptionId, approveUrl } = await this.paypal.createSubscription(
      newPlan,
      userEmail,
      startTime,
    );

    await this.supabase.db
      .from('app_subscriptions')
      .update({
        pending_paypal_subscription_id: subscriptionId,
        pending_plan: newPlan,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId);

    return {
      approveUrl,
      immediate,
      effectiveDate: immediate ? undefined : startTime.toISOString(),
    };
  }

  async completePlanChange(
    userId: string,
    newPaypalSubscriptionId: string,
  ): Promise<AppSubscription> {
    const sub = await this.getSubscriptionOrThrow(userId);

    if (sub.pending_paypal_subscription_id !== newPaypalSubscriptionId) {
      throw new BadRequestException('Subscription ID does not match pending plan change');
    }

    const paypalSub = await this.paypal.getSubscription(newPaypalSubscriptionId);
    if (paypalSub.status !== 'ACTIVE' && paypalSub.status !== 'APPROVED') {
      throw new BadRequestException('New PayPal subscription is not approved');
    }

    // Cancel the old PayPal subscription
    if (sub.paypal_subscription_id) {
      await this.paypal
        .cancelSubscription(sub.paypal_subscription_id, 'Plan change')
        .catch((e) => this.logger.error('Failed to cancel old PayPal sub', e));
    }

    const newPlan = sub.pending_plan!;
    const now = new Date();
    const startTime = newPlan === 'monthly' ? new Date(sub.current_period_end) : now;
    const newPeriodEnd = this.calcPeriodEnd(startTime, newPlan);
    const { last4, brand } = this.extractPaymentMethod(paypalSub);

    await this.supabase.db
      .from('app_subscriptions')
      .update({
        plan: newPlan,
        status: 'active',
        billing_day: startTime.getDate(),
        current_period_start: startTime.toISOString(),
        current_period_end: newPeriodEnd.toISOString(),
        next_billing_date: newPeriodEnd.toISOString(),
        paypal_subscription_id: newPaypalSubscriptionId,
        pending_paypal_subscription_id: null,
        pending_plan: null,
        payment_method_last4: last4,
        payment_method_brand: brand,
        grace_period_end: null,
        updated_at: now.toISOString(),
      })
      .eq('user_id', userId);

    return this.getSubscriptionOrThrow(userId);
  }

  // ─── Reactivation ─────────────────────────────────────────────────────────

  async reactivateSubscription(
    userId: string,
    userEmail: string,
  ): Promise<{ subscriptionId: string; approveUrl: string }> {
    const sub = await this.getSubscriptionOrThrow(userId);

    if (sub.status !== 'cancelled') {
      throw new BadRequestException('Subscription is not cancelled');
    }

    const now = new Date();
    const periodEnd = new Date(sub.current_period_end);

    // If still within the paid period, start the new subscription at period end
    // (no double charge). If already expired, start immediately with buffer.
    const startTime =
      periodEnd > now
        ? periodEnd
        : new Date(now.getTime() + 5 * 60 * 1000);

    const { subscriptionId, approveUrl } = await this.paypal.createSubscription(
      sub.plan,
      userEmail,
      startTime,
    );

    const newPeriodEnd = this.calcPeriodEnd(startTime, sub.plan);

    await this.supabase.db
      .from('app_subscriptions')
      .update({
        status: 'pending',
        paypal_subscription_id: subscriptionId,
        pending_paypal_subscription_id: null,
        pending_plan: null,
        billing_day: startTime.getDate(),
        current_period_start: startTime.toISOString(),
        current_period_end: newPeriodEnd.toISOString(),
        next_billing_date: newPeriodEnd.toISOString(),
        cancelled_at: null,
        grace_period_end: null,
        updated_at: now.toISOString(),
      })
      .eq('user_id', userId);

    return { subscriptionId, approveUrl };
  }

  // ─── Cancellation ──────────────────────────────────────────────────────────

  async cancelSubscription(userId: string): Promise<AppSubscription> {
    const sub = await this.getSubscriptionOrThrow(userId);

    if (sub.status === 'cancelled') {
      throw new BadRequestException('Subscription is already cancelled');
    }

    if (sub.paypal_subscription_id) {
      await this.paypal
        .cancelSubscription(sub.paypal_subscription_id, 'User requested cancellation')
        .catch((e) => this.logger.error('PayPal cancel failed', e));
    }

    const now = new Date();
    await this.supabase.db
      .from('app_subscriptions')
      .update({
        status: 'cancelled',
        payment_method_last4: null,
        payment_method_brand: null,
        cancelled_at: now.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq('user_id', userId);

    return this.getSubscriptionOrThrow(userId);
  }

  // ─── Payment method update ─────────────────────────────────────────────────

  async getPaymentMethodUpdateUrl(userId: string): Promise<{ updateUrl: string }> {
    const sub = await this.getSubscriptionOrThrow(userId);
    if (!sub.paypal_subscription_id) {
      throw new BadRequestException('No active PayPal subscription found');
    }

    const isSandbox = this.supabase.db !== null &&
      (process.env.PAYPAL_MODE !== 'live');
    const baseUrl = isSandbox
      ? 'https://www.sandbox.paypal.com'
      : 'https://www.paypal.com';

    return {
      updateUrl: `${baseUrl}/myaccount/autopay/connect/${sub.paypal_subscription_id}`,
    };
  }

  // ─── Payment history ───────────────────────────────────────────────────────

  async getPaymentHistory(userId: string) {
    const { data } = await this.supabase.db
      .from('payment_history')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(24);
    return data || [];
  }

  // ─── Webhook handlers ──────────────────────────────────────────────────────

  async handleWebhookEvent(event: {
    event_type: string;
    resource: Record<string, unknown>;
  }): Promise<void> {
    const { event_type, resource } = event;
    this.logger.log(`PayPal webhook: ${event_type}`);

    switch (event_type) {
      case 'BILLING.SUBSCRIPTION.ACTIVATED':
        await this.onSubscriptionActivated(resource);
        break;
      case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED':
        await this.onPaymentFailed(resource);
        break;
      case 'PAYMENT.SALE.COMPLETED':
        await this.onPaymentCompleted(resource);
        break;
      case 'BILLING.SUBSCRIPTION.RENEWED':
        await this.onSubscriptionRenewed(resource);
        break;
      case 'BILLING.SUBSCRIPTION.CANCELLED':
      case 'BILLING.SUBSCRIPTION.SUSPENDED':
      case 'BILLING.SUBSCRIPTION.EXPIRED':
        await this.onSubscriptionTerminated(resource);
        break;
      default:
        this.logger.debug(`Unhandled PayPal event: ${event_type}`);
    }
  }

  private async onSubscriptionActivated(resource: Record<string, unknown>) {
    const id = resource.id as string;
    await this.supabase.db
      .from('app_subscriptions')
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('paypal_subscription_id', id)
      .eq('status', 'pending');
  }

  private async onPaymentFailed(resource: Record<string, unknown>) {
    const id = resource.id as string;
    const { data: sub } = await this.supabase.db
      .from('app_subscriptions')
      .select('*')
      .eq('paypal_subscription_id', id)
      .maybeSingle();

    if (!sub) return;

    const now = new Date();
    // Grace period = last moment of the current month
    const gracePeriodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    await this.supabase.db
      .from('app_subscriptions')
      .update({
        status: 'past_due',
        grace_period_end: gracePeriodEnd.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq('paypal_subscription_id', id);

    await this.recordPayment(sub.user_id, sub.plan, 'failed', id, null, null);
    void this.alert.paymentFailed(sub.user_id);
  }

  private async onPaymentCompleted(resource: Record<string, unknown>) {
    const billingAgreementId = resource.billing_agreement_id as string | undefined;
    if (!billingAgreementId) return;

    const { data: sub } = await this.supabase.db
      .from('app_subscriptions')
      .select('*')
      .eq('paypal_subscription_id', billingAgreementId)
      .maybeSingle();

    if (!sub) return;

    const now = new Date();
    const newPeriodEnd = this.calcPeriodEnd(now, sub.plan as BillingPlan);
    const amount = (resource.amount as Record<string, string> | undefined)?.total;

    await this.supabase.db
      .from('app_subscriptions')
      .update({
        status: 'active',
        grace_period_end: null,
        current_period_start: now.toISOString(),
        current_period_end: newPeriodEnd.toISOString(),
        next_billing_date: newPeriodEnd.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq('paypal_subscription_id', billingAgreementId);

    await this.recordPayment(
      sub.user_id,
      sub.plan,
      'succeeded',
      billingAgreementId,
      resource.id as string,
      amount ? parseFloat(amount) : null,
    );
  }

  private async onSubscriptionRenewed(resource: Record<string, unknown>) {
    // Treated same as payment completed for our purposes
    await this.onPaymentCompleted(resource);
  }

  private async onSubscriptionTerminated(resource: Record<string, unknown>) {
    const id = resource.id as string;
    await this.supabase.db
      .from('app_subscriptions')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('paypal_subscription_id', id)
      .neq('status', 'cancelled');
  }

  private async recordPayment(
    userId: string,
    plan: string,
    status: 'succeeded' | 'failed',
    paypalSubscriptionId: string,
    captureId: string | null,
    overrideAmount: number | null,
  ) {
    const amount = overrideAmount ?? (plan === 'yearly' ? 100 : 8);
    const now = new Date();

    await this.supabase.db.from('payment_history').insert({
      user_id: userId,
      amount,
      currency: 'USD',
      status,
      plan,
      paypal_subscription_id: paypalSubscriptionId,
      paypal_capture_id: captureId,
      billing_date: now.toISOString().split('T')[0],
      description: `Vaultly ${plan} subscription — ${status}`,
    });
  }

  // ─── Cron: freeze accounts past grace period ───────────────────────────────

  @Cron('0 1 * * *') // 01:00 UTC daily
  async processGracePeriodExpirations(): Promise<void> {
    const now = new Date();
    const { data: expiredSubs, error } = await this.supabase.db
      .from('app_subscriptions')
      .select('id, user_id, paypal_subscription_id')
      .eq('status', 'past_due')
      .lt('grace_period_end', now.toISOString());

    if (error) {
      this.logger.error('Grace period cron error', error);
      return;
    }

    for (const sub of expiredSubs ?? []) {
      await this.supabase.db
        .from('app_subscriptions')
        .update({ status: 'frozen', updated_at: now.toISOString() })
        .eq('id', sub.id);

      if (sub.paypal_subscription_id) {
        await this.paypal
          .suspendSubscription(sub.paypal_subscription_id, 'Grace period expired')
          .catch((e) => this.logger.error('Failed to suspend PayPal sub', e));
      }

      void this.alert.accountFrozen(sub.user_id ?? sub.id, sub.id);
      this.logger.log(`Frozen subscription ${sub.id} — grace period expired`);
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private calcPeriodEnd(from: Date, plan: BillingPlan): Date {
    const d = new Date(from);
    if (plan === 'monthly') {
      const day = d.getDate();
      d.setMonth(d.getMonth() + 1);
      // Clamp to last valid day of the new month
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, lastDay));
    } else {
      d.setFullYear(d.getFullYear() + 1);
    }
    return d;
  }

  private extractPaymentMethod(paypalSub: {
    subscriber?: {
      payment_source?: { card?: { last_digits?: string; brand?: string } };
    };
  }): { last4: string | null; brand: string | null } {
    const card = paypalSub.subscriber?.payment_source?.card;
    return {
      last4: card?.last_digits ?? null,
      brand: card?.brand ?? null,
    };
  }
}
