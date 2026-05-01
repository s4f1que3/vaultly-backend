import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';
import { CreateSavingsPotDto, UpdateSavingsPotDto } from './savings-pots.dto';

@Injectable()
export class SavingsPotsService {
  constructor(private readonly supabase: SupabaseService) {}

  async findAll(userId: string) {
    const { data, error } = await this.supabase.db
      .from('savings_pots')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);
    return { data: data ?? [] };
  }

  async create(userId: string, dto: CreateSavingsPotDto) {
    const { data, error } = await this.supabase.db
      .from('savings_pots')
      .insert({ ...dto, amount: dto.amount ?? 0, user_id: userId })
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);
    return data;
  }

  async update(userId: string, id: string, dto: UpdateSavingsPotDto) {
    const { data: existing } = await this.supabase.db
      .from('savings_pots').select('id').eq('id', id).eq('user_id', userId).single();
    if (!existing) throw new NotFoundException('Savings pot not found');

    const { data, error } = await this.supabase.db
      .from('savings_pots').update(dto).eq('id', id).eq('user_id', userId).select().single();

    if (error) throw new BadRequestException(error.message);
    return data;
  }

  async delete(userId: string, id: string) {
    const { error } = await this.supabase.db
      .from('savings_pots').delete().eq('id', id).eq('user_id', userId);
    if (error) throw new BadRequestException(error.message);
  }
}
