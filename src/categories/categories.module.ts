import { Module } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { CategoriesController } from './categories.controller';
import { SupabaseService } from '../common/supabase.service';

@Module({
  controllers: [CategoriesController],
  providers: [CategoriesService, SupabaseService],
  exports: [CategoriesService],
})
export class CategoriesModule {}
