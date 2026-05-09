import { Module } from '@nestjs/common';
import { DebtsController } from './debts.controller';
import { DebtsService } from './debts.service';
import { SupabaseService } from '../common/supabase.service';

@Module({
  controllers: [DebtsController],
  providers: [DebtsService, SupabaseService],
})
export class DebtsModule {}
