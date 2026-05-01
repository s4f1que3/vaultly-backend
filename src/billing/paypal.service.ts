import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface PayPalTokenResponse {
  access_token: string;
  expires_in: number;
}

interface PayPalLink {
  href: string;
  rel: string;
  method: string;
}

interface PayPalSubscriptionResponse {
  id: string;
  status: string;
  links: PayPalLink[];
  subscriber?: {
    email_address?: string;
    payment_source?: {
      card?: {
        last_digits?: string;
        brand?: string;
        expiry?: string;
      };
    };
  };
  billing_info?: {
    next_billing_time?: string;
    last_payment?: {
      amount?: { value?: string };
      time?: string;
    };
  };
}

@Injectable()
export class PaypalService implements OnModuleInit {
  private readonly logger = new Logger(PaypalService.name);
  private readonly baseUrl: string;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;
  private monthlyPlanId: string | null = null;
  private yearlyPlanId: string | null = null;

  constructor(private readonly config: ConfigService) {
    this.baseUrl =
      config.get<string>('PAYPAL_MODE') === 'live'
        ? 'https://api-m.paypal.com'
        : 'https://api-m.sandbox.paypal.com';
  }

  async onModuleInit() {
    try {
      await this.initializePlans();
    } catch (err) {
      this.logger.error('Failed to initialize PayPal plans on startup', err);
    }
  }

  // ─── Auth ──────────────────────────────────────────────────────────────────

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const clientId = this.config.get<string>('PAYPAL_CLIENT_ID');
    const secret = this.config.get<string>('PAYPAL_CLIENT_SECRET');
    const credentials = Buffer.from(`${clientId}:${secret}`).toString('base64');

    const res = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`PayPal OAuth failed: ${body}`);
    }

    const data = (await res.json()) as PayPalTokenResponse;
    this.accessToken = data.access_token;
    // Expire 60s early to avoid edge cases
    this.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return this.accessToken;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = await this.getAccessToken();

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`PayPal ${method} ${path} failed [${res.status}]: ${errBody}`);
    }

    if (res.status === 204) return {} as T;
    return res.json() as Promise<T>;
  }

  // ─── One-time plan setup ───────────────────────────────────────────────────

  async initializePlans(): Promise<void> {
    this.monthlyPlanId = this.config.get<string>('PAYPAL_MONTHLY_PLAN_ID') || null;
    this.yearlyPlanId = this.config.get<string>('PAYPAL_YEARLY_PLAN_ID') || null;

    if (this.monthlyPlanId && this.yearlyPlanId) {
      this.logger.log(`Using existing PayPal plans: monthly=${this.monthlyPlanId}, yearly=${this.yearlyPlanId}`);
      return;
    }

    this.logger.log('PayPal plan IDs not found in env — creating product and plans...');

    const product = await this.createProduct();

    if (!this.monthlyPlanId) {
      const plan = await this.createPlan(product.id, 'monthly', 8);
      this.monthlyPlanId = plan.id;
      this.logger.log(`Created monthly plan: ${plan.id} — add PAYPAL_MONTHLY_PLAN_ID=${plan.id} to .env`);
    }

    if (!this.yearlyPlanId) {
      const plan = await this.createPlan(product.id, 'yearly', 100);
      this.yearlyPlanId = plan.id;
      this.logger.log(`Created yearly plan: ${plan.id} — add PAYPAL_YEARLY_PLAN_ID=${plan.id} to .env`);
    }
  }

  private async createProduct(): Promise<{ id: string }> {
    return this.request<{ id: string }>('POST', '/v1/catalogs/products', {
      name: 'Vaultly Premium',
      description: 'Full access to Vaultly personal budgeting',
      type: 'SERVICE',
      category: 'SOFTWARE',
    });
  }

  private async createPlan(
    productId: string,
    interval: 'monthly' | 'yearly',
    amount: number,
  ): Promise<{ id: string }> {
    return this.request<{ id: string }>('POST', '/v1/billing/plans', {
      product_id: productId,
      name: `Vaultly ${interval === 'monthly' ? 'Monthly' : 'Yearly'} Plan`,
      status: 'ACTIVE',
      billing_cycles: [
        {
          frequency: {
            interval_unit: interval === 'monthly' ? 'MONTH' : 'YEAR',
            interval_count: 1,
          },
          tenure_type: 'REGULAR',
          sequence: 1,
          total_cycles: 0,
          pricing_scheme: {
            fixed_price: {
              value: amount.toFixed(2),
              currency_code: 'USD',
            },
          },
        },
      ],
      payment_preferences: {
        auto_bill_outstanding: true,
        setup_fee_failure_action: 'CONTINUE',
        payment_failure_threshold: 3,
      },
    });
  }

  // ─── Subscriptions ─────────────────────────────────────────────────────────

  async createSubscription(
    plan: 'monthly' | 'yearly',
    userEmail: string,
    startTime: Date,
  ): Promise<{ subscriptionId: string; approveUrl: string }> {
    const planId = plan === 'monthly' ? this.monthlyPlanId : this.yearlyPlanId;
    if (!planId) throw new Error(`PayPal ${plan} plan ID not configured`);

    const frontendUrl = this.config.get<string>('FRONTEND_URL');

    const result = await this.request<PayPalSubscriptionResponse>(
      'POST',
      '/v1/billing/subscriptions',
      {
        plan_id: planId,
        start_time: startTime.toISOString(),
        subscriber: { email_address: userEmail },
        application_context: {
          brand_name: 'Vaultly',
          locale: 'en-US',
          return_url: `${frontendUrl}/billing/success`,
          cancel_url: `${frontendUrl}/billing/cancel`,
          shipping_preference: 'NO_SHIPPING',
          user_action: 'SUBSCRIBE_NOW',
        },
      },
    );

    const approveLink = result.links.find((l) => l.rel === 'approve');
    if (!approveLink) throw new Error('No approve link in PayPal subscription response');

    return { subscriptionId: result.id, approveUrl: approveLink.href };
  }

  async getSubscription(subscriptionId: string): Promise<PayPalSubscriptionResponse> {
    return this.request<PayPalSubscriptionResponse>(
      'GET',
      `/v1/billing/subscriptions/${subscriptionId}`,
    );
  }

  async cancelSubscription(subscriptionId: string, reason: string): Promise<void> {
    await this.request<void>(
      'POST',
      `/v1/billing/subscriptions/${subscriptionId}/cancel`,
      { reason: reason.slice(0, 128) },
    );
  }

  async suspendSubscription(subscriptionId: string, reason: string): Promise<void> {
    await this.request<void>(
      'POST',
      `/v1/billing/subscriptions/${subscriptionId}/suspend`,
      { reason: reason.slice(0, 128) },
    );
  }

  async activateSubscription(subscriptionId: string, reason: string): Promise<void> {
    await this.request<void>(
      'POST',
      `/v1/billing/subscriptions/${subscriptionId}/activate`,
      { reason: reason.slice(0, 128) },
    );
  }

  // ─── Webhook verification ──────────────────────────────────────────────────

  async verifyWebhookSignature(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
  ): Promise<boolean> {
    const webhookId = this.config.get<string>('PAYPAL_WEBHOOK_ID');
    if (!webhookId) {
      this.logger.warn('PAYPAL_WEBHOOK_ID not set — skipping webhook signature verification');
      return true;
    }

    try {
      const result = await this.request<{ verification_status: string }>(
        'POST',
        '/v1/notifications/verify-webhook-signature',
        {
          auth_algo: headers['paypal-auth-algo'],
          cert_url: headers['paypal-cert-url'],
          transmission_id: headers['paypal-transmission-id'],
          transmission_sig: headers['paypal-transmission-sig'],
          transmission_time: headers['paypal-transmission-time'],
          webhook_id: webhookId,
          webhook_event: JSON.parse(rawBody),
        },
      );
      return result.verification_status === 'SUCCESS';
    } catch (err) {
      this.logger.error('Webhook signature verification failed', err);
      return false;
    }
  }

  getMonthlyPlanId(): string | null {
    return this.monthlyPlanId;
  }

  getYearlyPlanId(): string | null {
    return this.yearlyPlanId;
  }

  // ─── One-time Orders (for license purchases) ───────────────────────────────

  async createOrder(amountUsd: number): Promise<string> {
    const result = await this.request<{ id: string }>('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: {
            currency_code: 'USD',
            value: amountUsd.toFixed(2),
          },
          description: 'Vaultly Lifetime License',
        },
      ],
      application_context: {
        brand_name: 'Vaultly',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'PAY_NOW',
      },
    });
    return result.id;
  }

  async captureOrder(orderId: string): Promise<void> {
    await this.request<unknown>('POST', `/v2/checkout/orders/${orderId}/capture`);
  }
}
