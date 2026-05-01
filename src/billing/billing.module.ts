import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { PaypalService } from './paypal.service';
import { SubscriptionGuard } from './guards/subscription.guard';
import { SupabaseService } from '../common/supabase.service';
import { AlertService } from '../common/alert.service';

@Module({
  controllers: [BillingController],
  providers: [
    BillingService,
    PaypalService,
    SupabaseService,
    AlertService,
    {
      provide: APP_GUARD,
      useClass: SubscriptionGuard,
    },
  ],
  exports: [BillingService],
})
export class BillingModule {}
