import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { LicensesService } from './licenses.service';
import { AuthGuard } from '../common/guards/auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { SkipBillingCheck } from '../common/decorators/skip-billing.decorator';
import {
  CapturePurchaseDto,
  InitiatePurchaseDto,
  RedeemLicenseDto,
  ValidateLicenseDto,
} from './dto/license.dto';
import type { User } from '@supabase/supabase-js';

@Controller('licenses')
export class LicensesController {
  constructor(private readonly licenses: LicensesService) {}

  // ─── Public: purchase flow (no account needed) ─────────────────────────────

  @Post('initiate-purchase')
  @HttpCode(200)
  @Public()
  async initiatePurchase(@Body() dto: InitiatePurchaseDto) {
    return this.licenses.initiatePurchase(dto.email);
  }

  @Post('capture-purchase')
  @HttpCode(200)
  @Public()
  async capturePurchase(@Body() dto: CapturePurchaseDto) {
    return this.licenses.capturePurchase(dto.order_id, dto.email);
  }

  // ─── Public: validate before signup ───────────────────────────────────────

  @Post('validate')
  @HttpCode(200)
  @Public()
  async validate(@Body() dto: ValidateLicenseDto) {
    return this.licenses.validateLicense(dto.license_key);
  }

  // ─── Authenticated: redeem after signup ───────────────────────────────────

  @Post('redeem')
  @HttpCode(200)
  @UseGuards(AuthGuard)
  @SkipBillingCheck()
  async redeem(@Body() dto: RedeemLicenseDto, @CurrentUser() user: User) {
    await this.licenses.redeemLicense(user.id, dto.license_key);
    return { success: true };
  }
}
