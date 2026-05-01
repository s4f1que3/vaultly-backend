import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter;

  constructor(private readonly config: ConfigService) {
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

  async sendLicenseEmail(to: string, licenseKey: string): Promise<void> {
    const fromName = this.config.get<string>('SMTP_FROM_NAME') ?? 'Vaultly';
    const fromEmail = this.config.get<string>('SMTP_USER');
    const frontendUrl = this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3000';
    const signupUrl = `${frontendUrl}/signup/license`;

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#0d0a06;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d0a06;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#1a1612;border-radius:16px;border:1px solid #2a2420;overflow:hidden;">
          <!-- Header -->
          <tr>
            <td style="padding:32px 40px 24px;border-bottom:1px solid #2a2420;">
              <p style="margin:0;font-size:22px;font-weight:700;color:#f5f0eb;letter-spacing:-0.5px;">Vaultly</p>
              <p style="margin:6px 0 0;font-size:13px;color:#8a7f76;">Your lifetime license</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px 40px;">
              <p style="margin:0 0 8px;font-size:15px;color:#c5bdb5;">Thank you for your purchase!</p>
              <p style="margin:0 0 28px;font-size:14px;color:#8a7f76;line-height:1.6;">
                Your one-time Vaultly Lifetime License is ready. Use the key below to create your account — no subscription required, ever.
              </p>

              <!-- License key box -->
              <div style="background:#0d0a06;border:1px solid #3a8c4e;border-radius:12px;padding:20px 24px;text-align:center;margin-bottom:28px;">
                <p style="margin:0 0 6px;font-size:11px;font-weight:600;color:#3a8c4e;letter-spacing:1px;text-transform:uppercase;">Your License Key</p>
                <p style="margin:0;font-size:22px;font-weight:700;color:#f5f0eb;letter-spacing:3px;font-family:'Courier New',monospace;">${licenseKey}</p>
              </div>

              <p style="margin:0 0 20px;font-size:13px;color:#8a7f76;line-height:1.6;">
                Keep this key safe. It is single-use and tied to your account once redeemed.
              </p>

              <!-- CTA -->
              <table cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="center">
                    <a href="${signupUrl}" style="display:inline-block;background:#3a8c4e;color:#f5f0eb;text-decoration:none;font-size:14px;font-weight:600;padding:14px 36px;border-radius:50px;">
                      Create my account →
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px 28px;border-top:1px solid #2a2420;">
              <p style="margin:0;font-size:12px;color:#5a5450;text-align:center;">
                If you didn't purchase this, you can safely ignore this email. Questions? Reply to this email.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    try {
      await this.transporter.sendMail({
        from: `"${fromName}" <${fromEmail}>`,
        to,
        subject: 'Your Vaultly Lifetime License Key',
        html,
        text: `Your Vaultly Lifetime License Key\n\n${licenseKey}\n\nUse this key to sign up at: ${signupUrl}\n\nThis is a single-use key — keep it safe.`,
      });
      this.logger.log(`License email sent to ${to}`);
    } catch (err) {
      this.logger.error(`Failed to send license email to ${to}`, err);
      throw err;
    }
  }
}
