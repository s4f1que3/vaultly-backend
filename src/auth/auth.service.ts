import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

interface OtpEntry {
  code: string;
  expiresAt: number;
  sentAt: number;
}

@Injectable()
export class AuthService {
  private supabase: SupabaseClient;
  private transporter: nodemailer.Transporter;
  private readonly otpStore = new Map<string, OtpEntry>();

  constructor(private readonly config: ConfigService) {
    this.supabase = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    );
    this.transporter = nodemailer.createTransport({
      host: config.get<string>('SMTP_HOST'),
      port: config.get<number>('SMTP_PORT') ?? 587,
      secure: config.get<string>('SMTP_SECURE') === 'true',
      auth: {
        user: config.get<string>('SMTP_USER'),
        pass: config.get<string>('SMTP_PASS'),
      },
    });
  }

  // ─── OTP helpers ─────────────────────────────────────────────────────────────

  private generateOtp(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  private cleanExpiredOtps(): void {
    const now = Date.now();
    for (const [key, entry] of this.otpStore.entries()) {
      if (entry.expiresAt < now) this.otpStore.delete(key);
    }
  }

  private async dispatchOtp(email: string): Promise<void> {
    this.cleanExpiredOtps();

    const existing = this.otpStore.get(email);
    const now = Date.now();

    if (existing && now - existing.sentAt < 60_000) {
      const secsLeft = Math.ceil((60_000 - (now - existing.sentAt)) / 1000);
      throw new BadRequestException(
        `Please wait ${secsLeft} seconds before requesting another code`,
      );
    }

    const code = this.generateOtp();
    this.otpStore.set(email, { code, expiresAt: now + 5 * 60_000, sentAt: now });

    await this.sendOtpEmail(email, code);
  }

  async sendEmailChangeOtp(
    userId: string,
    currentEmail: string,
    password: string,
    newEmail: string,
  ): Promise<void> {
    // 1. Current email must match the authenticated user
    const { data: userData, error: getUserError } =
      await this.supabase.auth.admin.getUserById(userId);
    if (getUserError || !userData.user) throw new UnauthorizedException('User not found');
    if (userData.user.email?.toLowerCase() !== currentEmail.toLowerCase()) {
      throw new BadRequestException('Current email is incorrect');
    }

    // 2. Password must be correct
    const { error: signInError } = await this.supabase.auth.signInWithPassword({
      email: currentEmail,
      password,
    });
    if (signInError) throw new BadRequestException('Incorrect password');

    // 3. New email must not already be taken
    const { data: allUsers, error: listError } =
      await this.supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listError) throw new InternalServerErrorException('Failed to verify email availability');
    const taken = allUsers.users.some(
      (u) => u.id !== userId && u.email?.toLowerCase() === newEmail.toLowerCase(),
    );
    if (taken) throw new BadRequestException('That email address is already in use by another account');

    // All checks passed — send OTP to the new email
    await this.dispatchOtp(newEmail);
  }

  async sendPasswordChangeOtp(userId: string, currentPassword: string): Promise<void> {
    const { data: userData, error: getUserError } =
      await this.supabase.auth.admin.getUserById(userId);
    if (getUserError || !userData.user || !userData.user.email) {
      throw new UnauthorizedException('User not found');
    }

    // Current password must be correct before sending anything
    const { error: signInError } = await this.supabase.auth.signInWithPassword({
      email: userData.user.email,
      password: currentPassword,
    });
    if (signInError) throw new BadRequestException('Current password is incorrect');

    await this.dispatchOtp(userData.user.email);
  }

  private verifyAndConsumeOtp(email: string, code: string): void {
    const entry = this.otpStore.get(email);
    if (!entry) {
      throw new BadRequestException(
        'No verification code found. Please request a new one.',
      );
    }
    if (Date.now() > entry.expiresAt) {
      this.otpStore.delete(email);
      throw new BadRequestException(
        'Verification code has expired. Please request a new one.',
      );
    }
    if (entry.code !== code) {
      throw new BadRequestException('Incorrect verification code.');
    }
    this.otpStore.delete(email);
  }

  private async sendOtpEmail(to: string, code: string): Promise<void> {
    const fromName = this.config.get<string>('SMTP_FROM_NAME') ?? 'Vaultly';
    const fromEmail = this.config.get<string>('SMTP_USER');
    const year = new Date().getFullYear();

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0d0a06;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d0a06;padding:40px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#1a1612;border-radius:16px;border:1px solid #2a2420;overflow:hidden;">
        <tr>
          <td style="padding:32px 40px 24px;border-bottom:1px solid #2a2420;">
            <p style="margin:0;font-size:22px;font-weight:700;color:#f5f0eb;letter-spacing:-0.5px;">Vaultly&#8482;</p>
            <p style="margin:6px 0 0;font-size:13px;color:#8a7f76;">Verification code</p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px;">
            <p style="margin:0 0 24px;font-size:14px;color:#8a7f76;line-height:1.6;">
              Use the code below to verify your identity. It expires in <strong style="color:#c5bdb5;">5 minutes</strong>.
            </p>
            <div style="background:#0d0a06;border:1px solid #3a8c4e;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px;">
              <p style="margin:0 0 8px;font-size:11px;font-weight:600;color:#3a8c4e;letter-spacing:1px;text-transform:uppercase;">Verification Code</p>
              <p style="margin:0;font-size:40px;font-weight:700;color:#f5f0eb;letter-spacing:14px;font-family:'Courier New',monospace;">${code}</p>
            </div>
            <p style="margin:0;font-size:12px;color:#5a5450;text-align:center;">
              If you didn&rsquo;t request this, you can safely ignore this email.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px;border-top:1px solid #2a2420;text-align:center;">
            <p style="margin:0;font-size:11px;color:#5a5450;">&copy; ${year} Vaultly &middot; This code expires in 5 minutes.</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    await this.transporter.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to,
      subject: `${code} — Your Vaultly™ verification code`,
      html,
      text: `Your Vaultly verification code: ${code}\n\nThis code expires in 5 minutes. If you didn't request this, ignore this email.`,
    });
  }

  // ─── Auth operations ──────────────────────────────────────────────────────────

  async checkEmailExists(email: string): Promise<void> {
    const { data, error } = await this.supabase.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });

    if (error) throw new InternalServerErrorException('Failed to verify email');

    const exists = data.users.some(
      (u) => u.email?.toLowerCase() === email.toLowerCase(),
    );

    if (!exists) throw new NotFoundException('No account found with this email address');
  }

  async changeEmail(
    userId: string,
    currentEmail: string,
    password: string,
    newEmail: string,
    otp: string,
  ): Promise<void> {
    // Verify OTP sent to the new email first
    this.verifyAndConsumeOtp(newEmail, otp);

    // Check the new email isn't already taken by another account
    const { data: allUsers, error: listError } =
      await this.supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listError) throw new InternalServerErrorException('Failed to verify email availability');
    const taken = allUsers.users.some(
      (u) => u.id !== userId && u.email?.toLowerCase() === newEmail.toLowerCase(),
    );
    if (taken) throw new BadRequestException('That email address is already in use by another account');

    const { data: userData, error: getUserError } =
      await this.supabase.auth.admin.getUserById(userId);

    if (getUserError || !userData.user) {
      throw new UnauthorizedException('User not found');
    }

    if (userData.user.email?.toLowerCase() !== currentEmail.toLowerCase()) {
      throw new UnauthorizedException('Current email is incorrect');
    }

    const { error: signInError } = await this.supabase.auth.signInWithPassword({
      email: currentEmail,
      password,
    });

    if (signInError) throw new UnauthorizedException('Incorrect password');

    const { error: updateError } = await this.supabase.auth.admin.updateUserById(
      userId,
      { email: newEmail, email_confirm: true },
    );

    if (updateError) throw new InternalServerErrorException(updateError.message);
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    otp: string,
  ): Promise<void> {
    const { data: userData, error: getUserError } =
      await this.supabase.auth.admin.getUserById(userId);

    if (getUserError || !userData.user || !userData.user.email) {
      throw new UnauthorizedException('User not found');
    }

    const email = userData.user.email;

    // OTP was sent to the user's current email
    this.verifyAndConsumeOtp(email, otp);

    const { error: signInError } = await this.supabase.auth.signInWithPassword({
      email,
      password: currentPassword,
    });

    if (signInError) throw new UnauthorizedException('Current password is incorrect');

    const { error: updateError } = await this.supabase.auth.admin.updateUserById(
      userId,
      { password: newPassword },
    );

    if (updateError) throw new InternalServerErrorException(updateError.message);
  }
}
