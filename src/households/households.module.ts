import { Module } from '@nestjs/common';
import { HouseholdsController } from './households.controller';
import { HouseholdsService } from './households.service';
import { SupabaseService } from '../common/supabase.service';

@Module({
  controllers: [HouseholdsController],
  providers: [HouseholdsService, SupabaseService],
  exports: [HouseholdsService],
})
export class HouseholdsModule {}
