import { Module } from '@nestjs/common';
import { CardsController } from './cards.controller';
import { CardsService } from './cards.service';
import { SupabaseService } from '../common/supabase.service';

@Module({
  controllers: [CardsController],
  providers: [CardsService, SupabaseService],
})
export class CardsModule {}
