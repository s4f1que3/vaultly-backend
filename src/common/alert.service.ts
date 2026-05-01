import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class AlertService {
  private readonly logger = new Logger(AlertService.name);
  private transporter: nodemailer.Transporter | null = null;
  private readonly alertEmail: string | undefined;
  // Simple in-memory cooldown to avoid alert spam (5 minutes per unique key)
  private readonly cooldowns = new Map<string, number>();
  private readonly COOLDOWN_MS = 5 * 60 * 1000;

  constructor(private readonly config: ConfigService) {
    const user = config.get<string>('SMTP_USER');
    const pass = config.get<string>('SMTP_PASS');
    this.alertEmail = config.get<string>('ALERT_EMAIL');

    if (user && pass && this.alertEmail) {
      this.transporter = nodemailer.createTransport({
        host: config.get<string>('SMTP_HOST') ?? 'smtp.gmail.com',
        port: config.get<number>('SMTP_PORT') ?? 587,
        secure: config.get<string>('SMTP_SECURE') === 'true',
        auth: { user, pass },
      });
    } else {
      this.logger.warn('AlertService: ALERT_EMAIL or SMTP creds not set — alerts disabled');
    }
  }

  async paymentFailed(userId: string): Promise<void> {
    if (!this.throttle(`payment_failed:${userId}`)) return;
    await this.send(
      '🚨 Vaultly: Payment Failed',
      `A payment failure was recorded for user ${userId}.\n\nTheir account is now past_due. They have until end of month before the account is frozen.`,
    );
  }

  async accountFrozen(userId: string, subscriptionId: string): Promise<void> {
    if (!this.throttle(`frozen:${userId}`)) return;
    await this.send(
      '🔒 Vaultly: Account Frozen',
      `User ${userId} has been frozen (subscription: ${subscriptionId}).\n\nTheir grace period expired without a successful payment.`,
    );
  }

  async criticalError(message: string, stack?: string): Promise<void> {
    // Deduplicate by first 60 chars of message
    if (!this.throttle(`error:${message.slice(0, 60)}`)) return;
    await this.send(
      '💥 Vaultly: Server Error',
      `${message}\n\n${stack ?? 'No stack trace available'}`,
    );
  }

  private throttle(key: string): boolean {
    const last = this.cooldowns.get(key) ?? 0;
    if (Date.now() - last < this.COOLDOWN_MS) return false;
    this.cooldowns.set(key, Date.now());
    return true;
  }

  private async send(subject: string, body: string): Promise<void> {
    if (!this.transporter || !this.alertEmail) return;
    try {
      await this.transporter.sendMail({
        from: `"Vaultly Alerts" <${this.config.get('SMTP_USER')}>`,
        to: this.alertEmail,
        subject,
        text: `${body}\n\n---\nSent at ${new Date().toISOString()}`,
      });
      this.logger.log(`Alert sent: ${subject}`);
    } catch (err) {
      this.logger.error('Failed to send alert email', err);
    }
  }
}
