import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';
import { CreateLiabilityDto, UpdateLiabilityDto } from './net-worth.dto';

@Injectable()
export class NetWorthService {
  constructor(private readonly supabase: SupabaseService) {}

  private round2(n: number) { return Math.round(n * 100) / 100; }

  // ── Liabilities CRUD ──────────────────────────────────────────────────────

  async getLiabilities(userId: string) {
    const { data, error } = await this.supabase.db
      .from('liabilities').select('*').eq('user_id', userId).order('created_at');
    if (error) throw new BadRequestException(error.message);
    return { data: data ?? [] };
  }

  async createLiability(userId: string, dto: CreateLiabilityDto) {
    const { data, error } = await this.supabase.db
      .from('liabilities').insert({ ...dto, user_id: userId }).select().single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  async updateLiability(userId: string, id: string, dto: UpdateLiabilityDto) {
    const { data: existing } = await this.supabase.db
      .from('liabilities').select('id').eq('id', id).eq('user_id', userId).single();
    if (!existing) throw new NotFoundException('Liability not found');

    const { data, error } = await this.supabase.db
      .from('liabilities').update(dto).eq('id', id).eq('user_id', userId).select().single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  async deleteLiability(userId: string, id: string) {
    const { error } = await this.supabase.db
      .from('liabilities').delete().eq('id', id).eq('user_id', userId);
    if (error) throw new BadRequestException(error.message);
  }

  // ── Full Net Worth Calculation ─────────────────────────────────────────────

  async getNetWorth(userId: string) {
    const [cardsRes, potsRes, goalsRes, liabRes, cardTxsRes] = await Promise.all([
      this.supabase.db.from('Cards').select('id, balance, card_holder, last_four, savings_pot_id').eq('user_id', userId),
      this.supabase.db.from('savings_pots').select('name, amount').eq('user_id', userId),
      this.supabase.db.from('Savings').select('name, current_amount').eq('user_id', userId).eq('status', 'active'),
      this.supabase.db.from('liabilities').select('*').eq('user_id', userId),
      this.supabase.db.from('Transactions').select('card_id, amount, type, budget_impact')
        .eq('user_id', userId).not('card_id', 'is', null),
    ]);

    const cards = cardsRes.data ?? [];
    const pots = potsRes.data ?? [];
    const goals = goalsRes.data ?? [];
    const liabilities = liabRes.data ?? [];

    // Apply transaction deltas to card base balances (same logic as Cards service)
    const deltaMap: Record<string, number> = {};
    for (const tx of (cardTxsRes.data ?? []) as { card_id: string; amount: number; type: string; budget_impact?: string }[]) {
      const d = tx.type === 'income' ? tx.amount : tx.type === 'expense' ? -tx.amount
        : tx.budget_impact === 'increase' ? tx.amount : tx.budget_impact === 'decrease' ? -tx.amount : 0;
      deltaMap[tx.card_id] = (deltaMap[tx.card_id] ?? 0) + d;
    }

    // Cards linked to a savings pot are excluded — the pot already represents that money
    const unlinkedCards = (cards as { id: string; balance: number; savings_pot_id?: string }[])
      .filter((c) => !c.savings_pot_id);

    const cardBalances = unlinkedCards.reduce(
      (s, c) => s + (c.balance ?? 0) + (deltaMap[c.id] ?? 0), 0,
    );
    const savingsPots = pots.reduce((s: number, p: { amount: number }) => s + (p.amount ?? 0), 0);
    const goalSavings = goals.reduce((s: number, g: { current_amount: number }) => s + (g.current_amount ?? 0), 0);
    const totalAssets = cardBalances + savingsPots + goalSavings;

    const totalLiabilities = liabilities.reduce((s: number, l: { balance: number }) => s + (l.balance ?? 0), 0);
    const netWorth = totalAssets - totalLiabilities;

    const breakdown: { label: string; amount: number }[] = [
      ...unlinkedCards.map((c) => ({
        label: `${(c as Record<string, unknown>).card_holder as string} ••••${(c as Record<string, unknown>).last_four as string}`,
        amount: (c.balance ?? 0) + (deltaMap[c.id] ?? 0),
      })),
      ...pots.map((p: { name: string; amount: number }) => ({ label: `Pot: ${p.name}`, amount: p.amount })),
      ...goals.map((g: { name: string; current_amount: number }) => ({ label: `Goal: ${g.name}`, amount: g.current_amount })),
    ];

    // Simple 6-point history: current value only (frontend can store rolling snapshots)
    const history = [{ label: 'Now', netWorth: this.round2(netWorth) }];

    return {
      netWorth: this.round2(netWorth),
      totalAssets: this.round2(totalAssets),
      totalLiabilities: this.round2(totalLiabilities),
      assets: {
        cardBalances: this.round2(cardBalances),
        savingsPots: this.round2(savingsPots),
        goalSavings: this.round2(goalSavings),
        breakdown,
      },
      liabilities: {
        total: this.round2(totalLiabilities),
        items: liabilities,
      },
      history,
    };
  }
}
