import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';
import { SupabaseService } from '../common/supabase.service';

@Module({
  controllers: [SettingsController],
  providers: [SettingsService, SupabaseService],
})
export class SettingsModule {}
