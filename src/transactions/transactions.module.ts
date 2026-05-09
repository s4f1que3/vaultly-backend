import { Module } from '@nestjs/common';
import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { SupabaseService } from '../common/supabase.service';
import { CategoriesModule } from '../categories/categories.module';
import { IntelligenceModule } from '../intelligence/intelligence.module';
import { HouseholdsModule } from '../households/households.module';

@Module({
  imports: [CategoriesModule, IntelligenceModule, HouseholdsModule],
  controllers: [TransactionsController],
  providers: [TransactionsService, SupabaseService],
  exports: [TransactionsService],
})
export class TransactionsModule {}
