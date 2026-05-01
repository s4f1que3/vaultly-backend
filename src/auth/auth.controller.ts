import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthGuard } from '../common/guards/auth.guard';
import { Public } from '../common/decorators/public.decorator';
import { SkipBillingCheck } from '../common/decorators/skip-billing.decorator';
import { z } from 'zod';

const CheckEmailDto = z.object({
  email: z.string().email(),
});

const ChangeEmailDto = z.object({
  currentEmail: z.string().email(),
  password: z.string().min(1),
  newEmail: z.string().email(),
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

  @Post('change-email')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @SkipBillingCheck()
  async changeEmail(@Body() body: unknown, @Req() req: Request & { user: { id: string } }) {
    const { currentEmail, password, newEmail } = ChangeEmailDto.parse(body);
    await this.authService.changeEmail(req.user.id, currentEmail, password, newEmail);
    return { success: true };
  }
}
