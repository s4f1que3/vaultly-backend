import { Module } from '@nestjs/common';
import { BudgetsController } from './budgets.controller';
import { BudgetsService } from './budgets.service';
import { SupabaseService } from '../common/supabase.service';
import { CategoriesModule } from '../categories/categories.module';
import { HouseholdsModule } from '../households/households.module';

@Module({
  imports: [CategoriesModule, HouseholdsModule],
  controllers: [BudgetsController],
  providers: [BudgetsService, SupabaseService],
})
export class BudgetsModule {}
