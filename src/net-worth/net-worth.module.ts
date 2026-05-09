import { Module } from '@nestjs/common';
import { NetWorthController } from './net-worth.controller';
import { NetWorthService } from './net-worth.service';
import { SupabaseService } from '../common/supabase.service';
import { RecurringTransactionsModule } from '../recurring-transactions/recurring-transactions.module';
import { CategoriesModule } from '../categories/categories.module';

@Module({
  imports: [RecurringTransactionsModule, CategoriesModule],
  controllers: [NetWorthController],
  providers: [NetWorthService, SupabaseService],
  exports: [NetWorthService],
})
export class NetWorthModule {}
