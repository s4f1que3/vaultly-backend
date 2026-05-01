import { Module } from '@nestjs/common';
import { GoalsController } from './goals.controller';
import { GoalsService } from './goals.service';
import { SupabaseService } from '../common/supabase.service';

@Module({
  controllers: [GoalsController],
  providers: [GoalsService, SupabaseService],
})
export class GoalsModule {}
