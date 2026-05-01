import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';
import { CreateCardDto, UpdateCardDto } from './cards.dto';

type DbCard = Record<string, unknown>;

function toFrontend(card: DbCard) {
  return {
    ...card,
    card_number: String(card.last_four ?? '').padStart(4, '0'),
    theme: card.color_theme,
    expiry_month: String(card.expiry_month ?? ''),
    expiry_year: String(card.expiry_year ?? ''),
  };
}

function toDb(dto: Partial<CreateCardDto>) {
  const { card_number, theme, expiry_month, expiry_year, ...rest } = dto as Record<string, unknown>;
  return {
    ...rest,
    ...(card_number !== undefined && { last_four: parseInt(String(card_number), 10) }),
    ...(theme !== undefined && { color_theme: theme }),
    ...(expiry_month !== undefined && { expiry_month: parseInt(String(expiry_month), 10) }),
    ...(expiry_year !== undefined && { expiry_year: parseInt(String(expiry_year), 10) }),
  };
}

@Injectable()
export class CardsService {
  constructor(private readonly supabase: SupabaseService) {}

  async findAll(userId: string) {
    const { data, error } = await this.supabase.db
      .from('Cards')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    if (error) throw new BadRequestException(error.message);
    return { data: (data ?? []).map(toFrontend) };
  }

  async create(userId: string, dto: CreateCardDto) {
    const { data: existing } = await this.supabase.db
      .from('Cards').select('id').eq('user_id', userId);
    const isDefault = !existing || existing.length === 0;

    const { data, error } = await this.supabase.db
      .from('Cards')
      .insert({ ...toDb(dto), user_id: userId, is_default: isDefault })
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);
    return toFrontend(data as DbCard);
  }

  async update(userId: string, id: string, dto: UpdateCardDto) {
    const { data: existing } = await this.supabase.db
      .from('Cards').select('id').eq('id', id).eq('user_id', userId).single();
    if (!existing) throw new NotFoundException('Card not found');

    const { data, error } = await this.supabase.db
      .from('Cards').update(toDb(dto)).eq('id', id).eq('user_id', userId).select().single();
    if (error) throw new BadRequestException(error.message);
    return toFrontend(data as DbCard);
  }

  async delete(userId: string, id: string) {
    const { data: existing } = await this.supabase.db
      .from('Cards').select('is_default').eq('id', id).eq('user_id', userId).single();
    if (!existing) throw new NotFoundException('Card not found');

    await this.supabase.db.from('Cards').delete().eq('id', id).eq('user_id', userId);

    if (existing.is_default) {
      const { data: next } = await this.supabase.db
        .from('Cards').select('id').eq('user_id', userId).limit(1).single();
      if (next) {
        await this.supabase.db.from('Cards').update({ is_default: true }).eq('id', next.id);
      }
    }
  }

  async setDefault(userId: string, id: string) {
    await this.supabase.db.from('Cards').update({ is_default: false }).eq('user_id', userId);
    const { data, error } = await this.supabase.db
      .from('Cards').update({ is_default: true }).eq('id', id).eq('user_id', userId).select().single();
    if (error) throw new NotFoundException('Card not found');
    return toFrontend(data as DbCard);
  }
}
