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
    const { page = 1, limit = 20, type, category, search, dateFrom, dateTo, cardId } = query;
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

    await this.updateBudgetSpent(userId, category_id, effectiveCategory);

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

    await this.updateBudgetSpent(userId, oldCategoryId, oldSlug);
    if (newCategoryId && newCategoryId !== oldCategoryId) {
      await this.updateBudgetSpent(userId, newCategoryId, newCategorySlug!);
    }

    const resolvedSlug = newCategorySlug ?? await this.categories.resolveSlug(userId, data.category_id);
    return { ...data, category: resolvedSlug };
  }

  async delete(userId: string, id: string) {
    const { data: existing } = await this.supabase.db
      .from('Transactions')
      .select('category_id')
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
    await this.updateBudgetSpent(userId, existing.category_id as string, slug);
  }

  private async updateBudgetSpent(userId: string, categoryId: string, categorySlug: string) {
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString();

    const { data: txs } = await this.supabase.db
      .from('Transactions')
      .select('amount')
      .eq('user_id', userId)
      .eq('category_id', categoryId)
      .eq('type', 'expense')
      .gte('date', startOfMonth)
      .lte('date', endOfMonth);

    const spent = txs?.reduce((s: number, t: { amount: number }) => s + t.amount, 0) ?? 0;

    // Only update this month's budget row
    await this.supabase.db
      .from('Budgets')
      .update({ spent_amount: spent })
      .eq('user_id', userId)
      .eq('category_id', categoryId)
      .eq('month', month)
      .eq('year', year);

    // Check alert threshold against this month's budget only
    const { data: budget } = await this.supabase.db
      .from('Budgets')
      .select('*')
      .eq('user_id', userId)
      .eq('category_id', categoryId)
      .eq('month', month)
      .eq('year', year)
      .single();

    if (budget && budget.limit_amount > 0) {
      const pct = (spent / budget.limit_amount) * 100;
      if (pct >= budget.alert_threshold) {
        await this.supabase.db.from('Notifications').insert({
          user_id: userId,
          type: 'budget_alert',
          title: `Budget Alert: ${categorySlug}`,
          body: `You've used ${pct.toFixed(0)}% of your ${categorySlug} budget (${spent.toFixed(2)} of ${budget.limit_amount.toFixed(2)})`,
          is_read: false,
        });
      }
    }
  }
}
