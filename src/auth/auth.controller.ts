import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthGuard } from '../common/guards/auth.guard';
import { Public } from '../common/decorators/public.decorator';
import { SkipBillingCheck } from '../common/decorators/skip-billing.decorator';
import { z } from 'zod';

const CheckEmailDto = z.object({
  email: z.string().email(),
});

const SendEmailChangeOtpDto = z.object({
  currentEmail: z.string().email(),
  password: z.string().min(1),
  newEmail: z.string().email(),
});

const SendPasswordChangeOtpDto = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
});

const ChangeEmailDto = z.object({
  currentEmail: z.string().email(),
  password: z.string().min(1),
  newEmail: z.string().email(),
  otp: z.string().length(6, 'Verification code must be 6 digits'),
});

const ChangePasswordDto = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
  otp: z.string().length(6, 'Verification code must be 6 digits'),
});

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('check-email')
  @HttpCode(200)
  @Public()
  async checkEmail(@Body() body: unknown) {
    const { email } = CheckEmailDto.parse(body);
    await this.authService.checkEmailExists(email);
    return { exists: true };
  }

  @Post('send-email-change-otp')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @SkipBillingCheck()
  async sendEmailChangeOtp(@Body() body: unknown, @Req() req: Request & { user: { id: string } }) {
    const { currentEmail, password, newEmail } = SendEmailChangeOtpDto.parse(body);
    await this.authService.sendEmailChangeOtp(req.user.id, currentEmail, password, newEmail);
    return { success: true };
  }

  @Post('send-password-change-otp')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @SkipBillingCheck()
  async sendPasswordChangeOtp(@Body() body: unknown, @Req() req: Request & { user: { id: string } }) {
    const parsed = SendPasswordChangeOtpDto.parse(body);
    await this.authService.sendPasswordChangeOtp(req.user.id, parsed.currentPassword);
    return { success: true };
  }

  @Post('change-email')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @SkipBillingCheck()
  async changeEmail(@Body() body: unknown, @Req() req: Request & { user: { id: string } }) {
    const { currentEmail, password, newEmail, otp } = ChangeEmailDto.parse(body);
    await this.authService.changeEmail(req.user.id, currentEmail, password, newEmail, otp);
    return { success: true };
  }

  @Post('change-password')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @SkipBillingCheck()
  async changePassword(@Body() body: unknown, @Req() req: Request & { user: { id: string } }) {
    const { currentPassword, newPassword, otp } = ChangePasswordDto.parse(body);
    await this.authService.changePassword(req.user.id, currentPassword, newPassword, otp);
    return { success: true };
  }
}
