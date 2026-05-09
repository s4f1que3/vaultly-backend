import { Module } from '@nestjs/common';
import { NetWorthController } from './net-worth.controller';
import { NetWorthService } from './net-worth.service';
import { SupabaseService } from '../common/supabase.service';

@Module({
  controllers: [NetWorthController],
  providers: [NetWorthService, SupabaseService],
  exports: [NetWorthService],
})
export class NetWorthModule {}
