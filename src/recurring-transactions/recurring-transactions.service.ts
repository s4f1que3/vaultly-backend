import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../common/supabase.service';
import { CategoriesService } from '../categories/categories.service';
import { CreateRecurringTransactionDto, UpdateRecurringTransactionDto } from './recurring-transactions.dto';

@Injectable()
export class RecurringTransactionsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly categories: CategoriesService,
  ) {}

  // ── Compute next due date based on frequency ──────────────────────────────

  private computeNextDue(frequency: string, from: Date, dayOfMonth?: number, dayOfWeek?: number): string {
    const d = new Date(from);
    switch (frequency) {
      case 'daily':
        d.setDate(d.getDate() + 1);
        break;
      case 'weekly':
        if (dayOfWeek !== undefined) {
          const diff = (dayOfWeek - d.getDay() + 7) % 7 || 7;
          d.setDate(d.getDate() + diff);
        } else {
          d.setDate(d.getDate() + 7);
        }
        break;
      case 'biweekly':
        d.setDate(d.getDate() + 14);
        break;
      case 'monthly':
        d.setMonth(d.getMonth() + 1);
        if (dayOfMonth) d.setDate(Math.min(dayOfMonth, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
        break;
      case 'yearly':
        d.setFullYear(d.getFullYear() + 1);
        break;
    }
    return d.toISOString().split('T')[0];
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async findAll(userId: string) {
    await this.categories.ensureDefaults(userId);
    const { data, error } = await this.supabase.db
      .from('recurring_transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);

    const rows = await Promise.all(
      (data ?? []).map(async (r: Record<string, unknown>) => ({
        ...r,
        category: await this.categories.resolveSlug(userId, r.category_id as string),
      })),
    );
    return { data: rows };
  }

  async create(userId: string, dto: CreateRecurringTransactionDto) {
    await this.categories.ensureDefaults(userId);
    const category_id = await this.categories.resolveId(userId, dto.category);
    const next_due_date = this.computeNextDue(
      dto.frequency,
      new Date(dto.start_date),
      dto.day_of_month,
      dto.day_of_week,
    );

    const { category: _cat, ...rest } = dto;
    const { data, error } = await this.supabase.db
      .from('recurring_transactions')
      .insert({ ...rest, category_id, user_id: userId, next_due_date })
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);
    return { ...data, category: dto.category };
  }

  async update(userId: string, id: string, dto: UpdateRecurringTransactionDto) {
    const { data: existing } = await this.supabase.db
      .from('recurring_transactions').select('*').eq('id', id).eq('user_id', userId).single();
    if (!existing) throw new NotFoundException('Recurring transaction not found');

    const update: Record<string, unknown> = { ...dto };
    if (dto.category) {
      update.category_id = await this.categories.resolveId(userId, dto.category);
      delete update.category;
    }

    const { data, error } = await this.supabase.db
      .from('recurring_transactions').update(update).eq('id', id).eq('user_id', userId).select().single();
    if (error) throw new BadRequestException(error.message);

    const category = await this.categories.resolveSlug(userId, (data as Record<string, unknown>).category_id as string);
    return { ...data, category };
  }

  async delete(userId: string, id: string) {
    const { error } = await this.supabase.db
      .from('recurring_transactions').delete().eq('id', id).eq('user_id', userId);
    if (error) throw new BadRequestException(error.message);
  }

  // ── Cron: process all due recurring transactions daily at 1am ─────────────

  @Cron('0 1 * * *')
  async processDueRecurring() {
    const today = new Date().toISOString().split('T')[0];

    const { data: due } = await this.supabase.db
      .from('recurring_transactions')
      .select('*')
      .eq('is_active', true)
      .lte('next_due_date', today);

    for (const rec of due ?? []) {
      // Skip if end_date has passed
      if (rec.end_date && rec.end_date < today) {
        await this.supabase.db
          .from('recurring_transactions')
          .update({ is_active: false })
          .eq('id', rec.id);
        continue;
      }

      // Insert the actual transaction
      await this.supabase.db.from('Transactions').insert({
        user_id: rec.user_id,
        amount: rec.amount,
        type: rec.type,
        category_id: rec.category_id,
        card_id: rec.card_id,
        description: rec.description ?? rec.name,
        merchant: rec.merchant,
        date: rec.next_due_date,
      });

      // Advance next_due_date
      const nextDue = this.computeNextDue(
        rec.frequency,
        new Date(rec.next_due_date),
        rec.day_of_month,
        rec.day_of_week,
      );
      await this.supabase.db
        .from('recurring_transactions')
        .update({ next_due_date: nextDue, last_processed_date: rec.next_due_date })
        .eq('id', rec.id);
    }
  }

  // Manual process for a single user (useful for testing)
  async processForUser(userId: string) {
    const today = new Date().toISOString().split('T')[0];
    const { data: due } = await this.supabase.db
      .from('recurring_transactions')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .lte('next_due_date', today);

    let processed = 0;
    for (const rec of due ?? []) {
      await this.supabase.db.from('Transactions').insert({
        user_id: rec.user_id,
        amount: rec.amount,
        type: rec.type,
        category_id: rec.category_id,
        card_id: rec.card_id,
        description: rec.description ?? rec.name,
        merchant: rec.merchant,
        date: rec.next_due_date,
      });

      const nextDue = this.computeNextDue(rec.frequency, new Date(rec.next_due_date), rec.day_of_month, rec.day_of_week);
      await this.supabase.db
        .from('recurring_transactions')
        .update({ next_due_date: nextDue, last_processed_date: rec.next_due_date })
        .eq('id', rec.id);
      processed++;
    }
    return { processed };
  }
}
