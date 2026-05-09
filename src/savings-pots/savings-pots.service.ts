import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
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

  // ── Savings Rules ─────────────────────────────────────────────────────────

  async getRules(userId: string) {
    const { data, error } = await this.supabase.db
      .from('savings_rules').select('*').eq('user_id', userId).order('created_at');
    if (error) throw new BadRequestException(error.message);
    return { data: data ?? [] };
  }

  async createRule(userId: string, dto: {
    pot_id: string; name: string; trigger_type: string;
    amount?: number; percentage?: number; day_of_month?: number;
  }) {
    const { data: pot } = await this.supabase.db
      .from('savings_pots').select('id').eq('id', dto.pot_id).eq('user_id', userId).single();
    if (!pot) throw new NotFoundException('Savings pot not found');

    const { data, error } = await this.supabase.db
      .from('savings_rules').insert({ ...dto, user_id: userId, is_active: true }).select().single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  async updateRule(userId: string, id: string, dto: Partial<{
    name: string; amount: number; percentage: number; day_of_month: number; is_active: boolean;
  }>) {
    const { data: existing } = await this.supabase.db
      .from('savings_rules').select('id').eq('id', id).eq('user_id', userId).single();
    if (!existing) throw new NotFoundException('Rule not found');

    const { data, error } = await this.supabase.db
      .from('savings_rules').update(dto).eq('id', id).eq('user_id', userId).select().single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  async deleteRule(userId: string, id: string) {
    const { error } = await this.supabase.db
      .from('savings_rules').delete().eq('id', id).eq('user_id', userId);
    if (error) throw new BadRequestException(error.message);
  }

  // ── Cron: process monthly rules on 1st of month, on_income rules on income detection ──

  @Cron('0 2 1 * *')
  async processMonthlyRules() {
    const today = new Date().toISOString().split('T')[0];

    const { data: rules } = await this.supabase.db
      .from('savings_rules').select('*').eq('is_active', true).eq('trigger_type', 'monthly');

    for (const rule of rules ?? []) {
      if (rule.last_run_date && rule.last_run_date.slice(0, 7) === today.slice(0, 7)) continue;

      const { data: pot } = await this.supabase.db
        .from('savings_pots').select('amount').eq('id', rule.pot_id).single();
      if (!pot) continue;

      const transferAmount = rule.amount ?? 0;
      if (transferAmount <= 0) continue;

      await this.supabase.db
        .from('savings_pots')
        .update({ amount: (pot as { amount: number }).amount + transferAmount })
        .eq('id', rule.pot_id);

      await this.supabase.db
        .from('savings_rules').update({ last_run_date: today }).eq('id', rule.id);

      // Create a record transaction
      await this.supabase.db.from('Transactions').insert({
        user_id: rule.user_id, amount: transferAmount, type: 'transfer',
        description: `Auto-transfer: ${rule.name}`, date: today, budget_impact: 'none',
        category_id: 'transfer',
      });
    }
  }

  async processIncomeRules(userId: string, incomeAmount: number) {
    const { data: rules } = await this.supabase.db
      .from('savings_rules').select('*')
      .eq('user_id', userId).eq('is_active', true)
      .in('trigger_type', ['on_income', 'percentage_of_income']);

    const today = new Date().toISOString().split('T')[0];

    for (const rule of rules ?? []) {
      const { data: pot } = await this.supabase.db
        .from('savings_pots').select('amount').eq('id', rule.pot_id).single();
      if (!pot) continue;

      const transferAmount = rule.trigger_type === 'percentage_of_income'
        ? (incomeAmount * (rule.percentage ?? 0)) / 100
        : (rule.amount ?? 0);
      if (transferAmount <= 0) continue;

      await this.supabase.db
        .from('savings_pots')
        .update({ amount: (pot as { amount: number }).amount + transferAmount })
        .eq('id', rule.pot_id);

      await this.supabase.db
        .from('savings_rules').update({ last_run_date: today }).eq('id', rule.id);
    }
  }
}
