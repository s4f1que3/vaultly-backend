import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';
import { PaypalService } from '../billing/paypal.service';
import { EmailService } from './email.service';

const LICENSE_PRICE = '2000.00';
const LICENSE_PRICE_NUM = 2000;

export interface License {
  id: string;
  license_key: string;
  buyer_email: string;
  paypal_order_id: string | null;
  status: 'unused' | 'used';
  used_by: string | null;
  used_at: string | null;
  created_at: string;
}

@Injectable()
export class LicensesService {
  private readonly logger = new Logger(LicensesService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly paypal: PaypalService,
    private readonly email: EmailService,
  ) {}

  // ─── Purchase flow ─────────────────────────────────────────────────────────

  async initiatePurchase(buyerEmail: string): Promise<{ orderId: string }> {
    const orderId = await this.paypal.createOrder(LICENSE_PRICE_NUM);
    return { orderId };
  }

  async capturePurchase(
    orderId: string,
    buyerEmail: string,
  ): Promise<{ licenseKey: string }> {
    // Idempotency — don't issue a second license for the same order
    const { data: existing } = await this.supabase.db
      .from('licenses')
      .select('license_key')
      .eq('paypal_order_id', orderId)
      .maybeSingle();

    if (existing) return { licenseKey: existing.license_key };

    // Capture the PayPal payment
    await this.paypal.captureOrder(orderId);

    const licenseKey = this.generateKey();

    await this.supabase.db.from('licenses').insert({
      license_key: licenseKey,
      buyer_email: buyerEmail,
      paypal_order_id: orderId,
      status: 'unused',
    });

    // Send email (non-blocking — don't fail the whole request if email fails)
    this.email.sendLicenseEmail(buyerEmail, licenseKey).catch((e) =>
      this.logger.error('License email failed', e),
    );

    return { licenseKey };
  }

  // ─── Validation ────────────────────────────────────────────────────────────

  async validateLicense(key: string): Promise<{ valid: boolean; message?: string }> {
    const normalized = key.trim().toUpperCase();

    const { data } = await this.supabase.db
      .from('licenses')
      .select('status')
      .eq('license_key', normalized)
      .maybeSingle();

    if (!data) return { valid: false, message: 'License key not found' };
    if (data.status === 'used') return { valid: false, message: 'This license has already been used' };

    return { valid: true };
  }

  // ─── Redemption ────────────────────────────────────────────────────────────

  async redeemLicense(userId: string, key: string): Promise<void> {
    const normalized = key.trim().toUpperCase();

    const { data: license } = await this.supabase.db
      .from('licenses')
      .select('id, status, used_by')
      .eq('license_key', normalized)
      .maybeSingle();

    if (!license) throw new BadRequestException('License key not found');

    // Already redeemed by this user → idempotent success
    if (license.status === 'used' && license.used_by === userId) return;

    // Redeemed by someone else
    if (license.status === 'used') {
      throw new ConflictException('This license has already been used');
    }

    const { error } = await this.supabase.db
      .from('licenses')
      .update({
        status: 'used',
        used_by: userId,
        used_at: new Date().toISOString(),
      })
      .eq('id', license.id)
      .eq('status', 'unused'); // Optimistic lock — prevents double redemption

    if (error) throw new ConflictException('License could not be redeemed — it may have just been used');
  }

  // ─── Access check ──────────────────────────────────────────────────────────

  async hasValidLicense(userId: string): Promise<boolean> {
    const { data } = await this.supabase.db
      .from('licenses')
      .select('id')
      .eq('used_by', userId)
      .eq('status', 'used')
      .maybeSingle();

    return !!data;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private generateKey(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No 0/O/1/I to avoid confusion
    const seg = () =>
      Array.from({ length: 4 }, () =>
        chars[Math.floor(Math.random() * chars.length)],
      ).join('');
    return `VLTLY-${seg()}-${seg()}-${seg()}-${seg()}`;
  }
}
