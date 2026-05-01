import { Module } from '@nestjs/common';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { SupabaseService } from '../common/supabase.service';
import { CategoriesModule } from '../categories/categories.module';
import { IntelligenceModule } from '../intelligence/intelligence.module';

@Module({
  imports: [CategoriesModule, IntelligenceModule],
  controllers: [TransactionsController],
  providers: [TransactionsService, SupabaseService],
  exports: [TransactionsService],
})
export class TransactionsModule {}
