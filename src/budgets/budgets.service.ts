import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../common/supabase.service';
import { CategoriesService } from '../categories/categories.service';
import { HouseholdsService } from '../households/households.service';
import { CreateBudgetDto, UpdateBudgetDto } from './budgets.dto';

@Injectable()
export class BudgetsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly categories: CategoriesService,
    private readonly households: HouseholdsService,
  ) {}

  private currentMonthYear() {
    const now = new Date();
    return { month: now.getMonth() + 1, year: now.getFullYear() };
  }

  // ── Current month budgets only ────────────────────────────────────────────

  async findAll(userId: string) {
    const { month, year } = this.currentMonthYear();

    const { data, error } = await this.supabase.db
      .from('Budgets')
      .select('*')
      .eq('user_id', userId)
      .eq('month', month)
      .eq('year', year)
      .order('created_at');

    if (error) throw new BadRequestException(error.message);

    await this.categories.ensureDefaults(userId);

    const memberIds = await this.households.getMemberIds(userId);
    const isHousehold = memberIds.length > 1;

    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];

    const rows = await Promise.all(
      (data ?? []).map(async (b: Record<string, unknown>) => {
        const category = await this.categories.resolveSlug(userId, b.category_id as string);

        if (!isHousehold) {
          return { ...b, category, period: 'monthly' };
        }

        // Aggregate spending across all household members for this category + month
        const { data: txs } = await this.supabase.db
          .from('Transactions')
          .select('amount')
          .in('user_id', memberIds)
          .eq('type', 'expense')
          .eq('category_id', b.category_id as string)
          .gte('date', startDate)
          .lte('date', endDate);

        const householdSpent = (txs ?? []).reduce(
          (s: number, t: { amount: number }) => s + (t.amount ?? 0), 0,
        );

        return {
          ...b,
          category,
          period: 'monthly',
          spent_amount: Math.round(householdSpent * 100) / 100,
          is_household: true,
        };
      }),
    );

    return { data: rows };
  }

  async create(userId: string, dto: CreateBudgetDto) {
    const { month, year } = this.currentMonthYear();
    const category_id = await this.categories.resolveId(userId, dto.category);

    // If a budget already exists for this category this month, update it instead
    const { data: existing } = await this.supabase.db
      .from('Budgets')
      .select('id')
      .eq('user_id', userId)
      .eq('category_id', category_id)
      .eq('month', month)
      .eq('year', year)
      .single();

    if (existing) {
      const { data, error } = await this.supabase.db
        .from('Budgets')
        .update({ limit_amount: dto.limit_amount, alert_threshold: dto.alert_threshold })
        .eq('id', (existing as { id: string }).id)
        .select()
        .single();
      if (error) throw new BadRequestException(error.message);
      return { ...data, category: dto.category, period: 'monthly' };
    }

    const { data, error } = await this.supabase.db
      .from('Budgets')
      .insert({
        user_id: userId,
        category_id,
        limit_amount: dto.limit_amount,
        alert_threshold: dto.alert_threshold,
        month,
        year,
        spent_amount: 0,
      })
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);
    return { ...data, category: dto.category, period: 'monthly' };
  }

  async update(userId: string, id: string, dto: UpdateBudgetDto) {
    const { data: existing } = await this.supabase.db
      .from('Budgets').select('id').eq('id', id).eq('user_id', userId).single();
    if (!existing) throw new NotFoundException('Budget not found');

    const updatePayload: Record<string, unknown> = {};
    if (dto.limit_amount !== undefined) updatePayload.limit_amount = dto.limit_amount;
    if (dto.alert_threshold !== undefined) updatePayload.alert_threshold = dto.alert_threshold;

    const { data, error } = await this.supabase.db
      .from('Budgets').update(updatePayload).eq('id', id).eq('user_id', userId).select().single();
    if (error) throw new BadRequestException(error.message);

    const category = await this.categories.resolveSlug(
      userId, (data as Record<string, unknown>).category_id as string,
    );
    return { ...data, category, period: 'monthly' };
  }

  async delete(userId: string, id: string) {
    const { error } = await this.supabase.db
      .from('Budgets').delete().eq('id', id).eq('user_id', userId);
    if (error) throw new BadRequestException(error.message);
  }

  // ── Budget history (past months) ──────────────────────────────────────────

  async getHistory(userId: string, months = 6) {
    await this.categories.ensureDefaults(userId);

    const { data, error } = await this.supabase.db
      .from('Budgets')
      .select('*')
      .eq('user_id', userId)
      .order('year', { ascending: false })
      .order('month', { ascending: false });

    if (error) throw new BadRequestException(error.message);

    // Group by month/year and attach category slugs
    const grouped = new Map<string, { month: number; year: number; budgets: object[] }>();
    for (const b of data ?? []) {
      const key = `${b.year}-${String(b.month).padStart(2, '0')}`;
      if (!grouped.has(key)) grouped.set(key, { month: b.month, year: b.year, budgets: [] });
      const slug = await this.categories.resolveSlug(userId, b.category_id as string);
      grouped.get(key)!.budgets.push({
        ...b,
        category: slug,
        period: 'monthly',
        utilizationPct: b.limit_amount > 0
          ? Math.round((b.spent_amount / b.limit_amount) * 100)
          : 0,
      });
    }

    return {
      data: [...grouped.values()].slice(0, months),
    };
  }

  async toggleRollover(userId: string, id: string, enabled: boolean) {
    const { data: existing } = await this.supabase.db
      .from('Budgets').select('id').eq('id', id).eq('user_id', userId).single();
    if (!existing) throw new NotFoundException('Budget not found');

    const { data, error } = await this.supabase.db
      .from('Budgets').update({ rollover_enabled: enabled }).eq('id', id).eq('user_id', userId).select().single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  // ── Monthly rollover ──────────────────────────────────────────────────────
  // Runs at midnight on the 1st of every month.
  // Copies last month's budget limits into new rows; carries unspent amounts if rollover_enabled.

  @Cron('0 0 1 * *')
  async rolloverAllUsers() {
    const now = new Date();
    const curMonth = now.getMonth() + 1;
    const curYear = now.getFullYear();
    const prevMonth = curMonth === 1 ? 12 : curMonth - 1;
    const prevYear = curMonth === 1 ? curYear - 1 : curYear;

    const { data: lastMonth } = await this.supabase.db
      .from('Budgets')
      .select('*')
      .eq('month', prevMonth)
      .eq('year', prevYear);

    if (!lastMonth?.length) return;

    for (const budget of lastMonth) {
      const { data: exists } = await this.supabase.db
        .from('Budgets')
        .select('id')
        .eq('user_id', budget.user_id)
        .eq('category_id', budget.category_id)
        .eq('month', curMonth)
        .eq('year', curYear)
        .single();

      if (!exists) {
        const unspent = Math.max(0, (budget.limit_amount ?? 0) - (budget.spent_amount ?? 0));
        const rollover_amount = budget.rollover_enabled ? unspent : 0;
        await this.supabase.db.from('Budgets').insert({
          user_id: budget.user_id,
          category_id: budget.category_id,
          limit_amount: budget.limit_amount,
          alert_threshold: budget.alert_threshold,
          rollover_enabled: budget.rollover_enabled ?? false,
          rollover_amount,
          month: curMonth,
          year: curYear,
          spent_amount: 0,
        });
      }
    }
  }

  // Manual trigger — useful for testing or first-time setup mid-month
  async rolloverForUser(userId: string) {
    const now = new Date();
    const curMonth = now.getMonth() + 1;
    const curYear = now.getFullYear();
    const prevMonth = curMonth === 1 ? 12 : curMonth - 1;
    const prevYear = curMonth === 1 ? curYear - 1 : curYear;

    const { data: lastMonth } = await this.supabase.db
      .from('Budgets')
      .select('*')
      .eq('user_id', userId)
      .eq('month', prevMonth)
      .eq('year', prevYear);

    if (!lastMonth?.length) return { created: 0, message: 'No budgets found from last month' };

    let created = 0;
    for (const budget of lastMonth) {
      const { data: exists } = await this.supabase.db
        .from('Budgets')
        .select('id')
        .eq('user_id', userId)
        .eq('category_id', budget.category_id)
        .eq('month', curMonth)
        .eq('year', curYear)
        .single();

      if (!exists) {
        const unspent = Math.max(0, (budget.limit_amount ?? 0) - (budget.spent_amount ?? 0));
        const rollover_amount = budget.rollover_enabled ? unspent : 0;
        await this.supabase.db.from('Budgets').insert({
          user_id: userId,
          category_id: budget.category_id,
          limit_amount: budget.limit_amount,
          alert_threshold: budget.alert_threshold,
          rollover_enabled: budget.rollover_enabled ?? false,
          rollover_amount,
          month: curMonth,
          year: curYear,
          spent_amount: 0,
        });
        created++;
      }
    }

    return { created, message: `Rolled over ${created} budget(s) from last month` };
  }
}
