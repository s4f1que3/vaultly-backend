import { Module } from '@nestjs/common';
import { RecurringTransactionsController } from './recurring-transactions.controller';
import { RecurringTransactionsService } from './recurring-transactions.service';
import { SupabaseService } from '../common/supabase.service';
import { CategoriesModule } from '../categories/categories.module';

@Module({
  imports: [CategoriesModule],
  controllers: [RecurringTransactionsController],
  providers: [RecurringTransactionsService, SupabaseService],
  exports: [RecurringTransactionsService],
})
export class RecurringTransactionsModule {}
