import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';
import { CreateCardDto, UpdateCardDto } from './cards.dto';

type DbCard = Record<string, unknown>;
type TxRow = { card_id: string; amount: unknown; type: string; budget_impact?: string };

function txDelta(amount: number, type: string, budgetImpact?: string): number {
  if (type === 'income') return amount;
  if (type === 'expense') return -amount;
  if (type === 'transfer') {
    if (budgetImpact === 'increase') return amount;
    if (budgetImpact === 'decrease') return -amount;
  }
  return 0;
}

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
    const { data: cards, error } = await this.supabase.db
      .from('Cards')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true });
    if (error) throw new BadRequestException(error.message);

    const { data: txs } = await this.supabase.db
      .from('Transactions')
      .select('card_id, amount, type, budget_impact')
      .eq('user_id', userId)
      .not('card_id', 'is', null);

    const deltaMap: Record<string, number> = {};
    for (const tx of (txs ?? []) as TxRow[]) {
      const d = txDelta(parseFloat(String(tx.amount)), tx.type, tx.budget_impact);
      deltaMap[tx.card_id] = (deltaMap[tx.card_id] ?? 0) + d;
    }

    return {
      data: (cards ?? []).map((card) => {
        const initial = parseFloat(String(card.balance ?? 0));
        return toFrontend({ ...card, balance: initial + (deltaMap[card.id as string] ?? 0) });
      }),
    };
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
