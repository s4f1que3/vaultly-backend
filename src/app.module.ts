import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { TransactionsModule } from './transactions/transactions.module';
import { CardsModule } from './cards/cards.module';
import { BudgetsModule } from './budgets/budgets.module';
import { GoalsModule } from './goals/goals.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SettingsModule } from './settings/settings.module';
import { CategoriesModule } from './categories/categories.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { IntelligenceModule } from './intelligence/intelligence.module';
import { SummariesModule } from './summaries/summaries.module';
import { BillingModule } from './billing/billing.module';
import { LicensesModule } from './licenses/licenses.module';
import { SavingsPotsModule } from './savings-pots/savings-pots.module';
import { AuthGuard } from './common/guards/auth.guard';
import { AlertService } from './common/alert.service';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    // 100 requests per 60 seconds per IP globally
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    AuthModule,
    CategoriesModule,
    TransactionsModule,
    CardsModule,
    BudgetsModule,
    GoalsModule,
    NotificationsModule,
    SettingsModule,
    SubscriptionsModule,
    IntelligenceModule,
    SummariesModule,
    BillingModule,
    LicensesModule,
    SavingsPotsModule,
  ],
  providers: [
    AlertService,
    // Guard order: ThrottlerGuard → AuthGuard → SubscriptionGuard (in BillingModule)
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    // Filter with DI so AlertService can be injected
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule {}
