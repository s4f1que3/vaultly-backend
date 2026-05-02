import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';
import { CategoriesService } from '../categories/categories.service';
import { IntelligenceService } from '../intelligence/intelligence.service';
import { CreateTransactionDto, UpdateTransactionDto, TransactionQueryDto } from './transactions.dto';

@Injectable()
export class TransactionsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly categories: CategoriesService,
    private readonly intelligence: IntelligenceService,
  ) {}

  async findAll(userId: string, query: TransactionQueryDto) {
    const { page = 1, limit = 20, type, category, search, dateFrom, dateTo, cardId, merchant } = query;
    const offset = (page - 1) * limit;

    let q = this.supabase.db
      .from('Transactions')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('date', { ascending: false })
      .range(offset, offset + limit - 1);

    if (type) q = q.eq('type', type);
    if (dateFrom) q = q.gte('date', dateFrom);
    if (dateTo) q = q.lte('date', dateTo);
    if (cardId) q = q.eq('card_id', cardId);
    if (merchant) q = q.ilike('merchant', merchant);
    if (search) q = q.or(`description.ilike.%${search}%,merchant.ilike.%${search}%`);

    if (category) {
      const categoryId = await this.categories.resolveId(userId, category);
      q = q.eq('category_id', categoryId);
    }

    const { data, error, count } = await q;
    if (error) throw new BadRequestException(error.message);

    await this.categories.ensureDefaults(userId);
    const rows = await Promise.all(
      (data ?? []).map(async (tx: Record<string, unknown>) => ({
        ...tx,
        category: await this.categories.resolveSlug(userId, tx.category_id as string),
      })),
    );

    return {
      data: rows,
      meta: {
        total: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit),
      },
    };
  }

  async create(userId: string, dto: CreateTransactionDto) {
    // Auto-categorize from merchant if a learned rule or pattern matches
    let effectiveCategory = dto.category;
    if (dto.merchant) {
      const suggested = await this.intelligence.resolveMerchantCategory(userId, dto.merchant);
      if (suggested) effectiveCategory = suggested as typeof dto.category;
    }

    const category_id = await this.categories.resolveId(userId, effectiveCategory);
    const { category: _cat, ...rest } = dto;
    const card_id = rest.card_id || null;
    delete rest.card_id;

    const { data, error } = await this.supabase.db
      .from('Transactions')
      .insert({ ...rest, category_id, card_id, user_id: userId })
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);

    await this.updateBudgetSpent(userId, category_id, effectiveCategory, dto.date);
    await this.adjustCardBalance(userId, card_id, this.balanceDelta(dto.type, dto.amount, dto.budget_impact));

    return { ...data, category: effectiveCategory };
  }

  async update(userId: string, id: string, dto: UpdateTransactionDto) {
    const { data: existing } = await this.supabase.db
      .from('Transactions')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (!existing) throw new NotFoundException('Transaction not found');

    const update: Record<string, unknown> = { ...dto };
    update.card_id = update.card_id || null;
    let newCategoryId: string | undefined;
    let newCategorySlug: string | undefined;

    if (dto.category) {
      newCategoryId = await this.categories.resolveId(userId, dto.category);
      newCategorySlug = dto.category;
      update.category_id = newCategoryId;
      delete update.category;

      // Learn the correction: if user explicitly re-categorizes a merchant, remember it
      const merchant = (dto.merchant ?? existing.merchant) as string | undefined;
      if (merchant) {
        await this.intelligence.learnMerchantRule(userId, merchant, dto.category);
      }
    }

    const { data, error } = await this.supabase.db
      .from('Transactions')
      .update(update)
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);

    const oldCategoryId = existing.category_id as string;
    const oldSlug = await this.categories.resolveSlug(userId, oldCategoryId);
    const oldDate = existing.date as string;
    const newDate = (dto.date ?? existing.date) as string;

    // Always recalculate old category in the old transaction's month
    await this.updateBudgetSpent(userId, oldCategoryId, oldSlug, oldDate);

    if (newCategoryId && newCategoryId !== oldCategoryId) {
      // Category changed: recalculate new category in new date's month
      await this.updateBudgetSpent(userId, newCategoryId, newCategorySlug!, newDate);
    } else if (dto.date && dto.date !== oldDate) {
      // Only date changed: also recalculate same category in new date's month
      await this.updateBudgetSpent(userId, oldCategoryId, oldSlug, newDate);
    }

    // Reverse old card balance effect, then apply new
    const oldCardId = (existing.card_id as string | null) ?? null;
    const newCardId = (dto.card_id !== undefined ? (dto.card_id || null) : oldCardId);
    await this.adjustCardBalance(userId, oldCardId, -this.balanceDelta(existing.type as string, existing.amount as number, existing.budget_impact as string | undefined));
    await this.adjustCardBalance(userId, newCardId, this.balanceDelta(dto.type ?? existing.type as string, dto.amount ?? existing.amount as number, dto.budget_impact ?? existing.budget_impact as string | undefined));

    const resolvedSlug = newCategorySlug ?? await this.categories.resolveSlug(userId, data.category_id);
    return { ...data, category: resolvedSlug };
  }

  async delete(userId: string, id: string) {
    const { data: existing } = await this.supabase.db
      .from('Transactions')
      .select('category_id, date, card_id, amount, type, budget_impact')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (!existing) throw new NotFoundException('Transaction not found');

    const { error } = await this.supabase.db
      .from('Transactions')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) throw new BadRequestException(error.message);

    const slug = await this.categories.resolveSlug(userId, existing.category_id as string);
    await this.updateBudgetSpent(userId, existing.category_id as string, slug, existing.date as string);
    await this.adjustCardBalance(userId, (existing.card_id as string | null) ?? null, -this.balanceDelta(existing.type as string, existing.amount as number, existing.budget_impact as string | undefined));
  }

  private balanceDelta(type: string, amount: number, budgetImpact?: string): number {
    if (type === 'income') return amount;
    if (type === 'expense') return -amount;
    // transfer: honour the user's explicit impact choice
    if (budgetImpact === 'increase') return amount;
    if (budgetImpact === 'decrease') return -amount;
    return 0; // 'none'
  }

  private async adjustCardBalance(userId: string, cardId: string | null, delta: number) {
    if (!cardId || delta === 0) return;

    const { data: card, error: fetchErr } = await this.supabase.db
      .from('Cards')
      .select('balance')
      .eq('id', cardId)
      .eq('user_id', userId)
      .single();

    if (fetchErr || !card) return;

    // Supabase returns NUMERIC columns as strings — parse explicitly
    const current = parseFloat(String(card.balance ?? '0'));
    const newBalance = Math.round((current + delta) * 100) / 100;

    await this.supabase.db
      .from('Cards')
      .update({ balance: newBalance })
      .eq('id', cardId)
      .eq('user_id', userId);
  }

  private async updateBudgetSpent(userId: string, categoryId: string, categorySlug: string, forDate?: string) {
    const ref = forDate ? new Date(forDate) : new Date();
    const month = ref.getMonth() + 1;
    const year = ref.getFullYear();
    const startOfMonth = new Date(ref.getFullYear(), ref.getMonth(), 1).toISOString();
    const endOfMonth = new Date(ref.getFullYear(), ref.getMonth() + 1, 0).toISOString();

    const { data: txs } = await this.supabase.db
      .from('Transactions')
      .select('amount, type, budget_impact')
      .eq('user_id', userId)
      .eq('category_id', categoryId)
      .gte('date', startOfMonth)
      .lte('date', endOfMonth);

    type TxRow = { amount: number; type: string; budget_impact?: string };

    // spent = expenses + transfers marked as decrease
    const spent = (txs ?? []).reduce((s: number, t: TxRow) => {
      if (t.type === 'expense') return s + t.amount;
      if (t.type === 'transfer' && t.budget_impact === 'decrease') return s + t.amount;
      return s;
    }, 0);

    // income_received = income + transfers marked as increase (adds to the budget pool)
    const income_received = (txs ?? []).reduce((s: number, t: TxRow) => {
      if (t.type === 'income') return s + t.amount;
      if (t.type === 'transfer' && t.budget_impact === 'increase') return s + t.amount;
      return s;
    }, 0);

    // Only update this month's budget row
    await this.supabase.db
      .from('Budgets')
      .update({ spent_amount: spent, income_amount: income_received })
      .eq('user_id', userId)
      .eq('category_id', categoryId)
      .eq('month', month)
      .eq('year', year);

    // Check alert threshold against effective limit (base limit + income received)
    const { data: budget } = await this.supabase.db
      .from('Budgets')
      .select('*')
      .eq('user_id', userId)
      .eq('category_id', categoryId)
      .eq('month', month)
      .eq('year', year)
      .single();

    if (budget) {
      const effectiveLimit = (budget.limit_amount ?? 0) + (budget.income_amount ?? 0);
      const pct = effectiveLimit > 0 ? (spent / effectiveLimit) * 100 : 0;
      if (pct >= budget.alert_threshold) {
        await this.supabase.db.from('Notifications').insert({
          user_id: userId,
          type: 'budget_alert',
          title: `Budget Alert: ${categorySlug}`,
          body: `You've used ${pct.toFixed(0)}% of your ${categorySlug} budget (${spent.toFixed(2)} of ${effectiveLimit.toFixed(2)})`,
          is_read: false,
        });
      }
    }
  }
}
