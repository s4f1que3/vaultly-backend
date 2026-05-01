import { Module } from '@nestjs/common';
import { IntelligenceController } from './intelligence.controller';
import { IntelligenceService } from './intelligence.service';
import { SupabaseService } from '../common/supabase.service';
import { CategoriesModule } from '../categories/categories.module';

@Module({
  imports: [CategoriesModule],
  controllers: [IntelligenceController],
  providers: [IntelligenceService, SupabaseService],
  exports: [IntelligenceService],
})
export class IntelligenceModule {}
