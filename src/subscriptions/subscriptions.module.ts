import { Module } from '@nestjs/common';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';
import { SupabaseService } from '../common/supabase.service';
import { CategoriesModule } from '../categories/categories.module';

@Module({
  imports: [CategoriesModule],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService, SupabaseService],
})
export class SubscriptionsModule {}
