import { Module } from '@nestjs/common';
import { LicensesController } from './licenses.controller';
import { LicensesService } from './licenses.service';
import { EmailService } from './email.service';
import { SupabaseService } from '../common/supabase.service';
import { PaypalService } from '../billing/paypal.service';

@Module({
  controllers: [LicensesController],
  providers: [LicensesService, EmailService, SupabaseService, PaypalService],
  exports: [LicensesService],
})
export class LicensesModule {}
