import { Module } from '@nestjs/common';
import { SavingsPotsController } from './savings-pots.controller';
import { SavingsPotsService } from './savings-pots.service';
import { SupabaseService } from '../common/supabase.service';

@Module({
  controllers: [SavingsPotsController],
  providers: [SavingsPotsService, SupabaseService],
})
export class SavingsPotsModule {}
