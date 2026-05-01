import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../common/supabase.service';
import { CategoriesService } from '../categories/categories.service';
import { CreateSubscriptionDto, UpdateSubscriptionDto } from './subscriptions.dto';

@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly categories: CategoriesService,
  ) {}

  private calcNextDue(period: 'monthly' | 'yearly', billingDay: number, billingMonth?: number): string {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let target: Date;

    if (period === 'monthly') {
      target = new Date(today.getFullYear(), today.getMonth(), billingDay);
      if (target <= today) {
        target = new Date(today.getFullYear(), today.getMonth() + 1, billingDay);
      }
    } else {
      const month = (billingMonth ?? 1) - 1;
      target = new Date(today.getFullYear(), month, billingDay);
      if (target <= today) {
        target = new Date(today.getFullYear() + 1, month, billingDay);
      }
    }

    return target.toISOString().split('T')[0];
  }

  async findAll(userId: string) {
    await this.processForUser(userId);
    const { data, error } = await this.supabase.db
      .from('Subscriptions')
      .select('*')
      .eq('user_id', userId)
      .order('company');
    if (error) throw new BadRequestException(error.message);
    return { data };
  }

  async create(userId: string, dto: CreateSubscriptionDto) {
    const next_due_date = this.calcNextDue(dto.period, dto.billing_day, dto.billing_month);
    const card_id = dto.card_id || null;

    const { data, error } = await this.supabase.db
      .from('Subscriptions')
      .insert({ ...dto, card_id, user_id: userId, next_due_date, is_active: true })
      .select()
      .single();

    if (error) throw new BadRequestException(error.message);
    return data;
  }

  async update(userId: string, id: string, dto: UpdateSubscriptionDto) {
    const { data: existing } = await this.supabase.db
      .from('Subscriptions').select('*').eq('id', id).eq('user_id', userId).single();
    if (!existing) throw new NotFoundException('Subscription not found');

    const updates: Record<string, unknown> = { ...dto };
    if ('card_id' in updates) updates.card_id = updates.card_id || null;

    if (dto.billing_day || dto.billing_month || dto.period) {
      updates.next_due_date = this.calcNextDue(
        (dto.period ?? existing.period) as 'monthly' | 'yearly',
        dto.billing_day ?? existing.billing_day,
        dto.billing_month ?? existing.billing_month,
      );
    }

    const { data, error } = await this.supabase.db
      .from('Subscriptions').update(updates).eq('id', id).eq('user_id', userId).select().single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  async delete(userId: string, id: string) {
    const { error } = await this.supabase.db
      .from('Subscriptions').delete().eq('id', id).eq('user_id', userId);
    if (error) throw new BadRequestException(error.message);
  }

  async processForUser(userId: string) {
    const today = new Date().toISOString().split('T')[0];

    const { data: due } = await this.supabase.db
      .from('Subscriptions')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .lte('next_due_date', today);

    if (!due?.length) return;

    const categoryId = await this.categories.resolveId(userId, 'utilities');

    for (const sub of due) {
      await this.supabase.db.from('Transactions').insert({
        user_id: userId,
        amount: sub.amount,
        type: 'expense',
        category_id: categoryId,
        description: `${sub.company} subscription`,
        card_id: sub.card_id ?? null,
        date: sub.next_due_date,
      });

      await this.supabase.db
        .from('Subscriptions')
        .update({
          next_due_date: this.calcNextDue(sub.period, sub.billing_day, sub.billing_month),
          last_processed_date: today,
        })
        .eq('id', sub.id);
    }
  }

  // Runs every day at midnight — processes all users with due subscriptions
  @Cron('0 0 * * *')
  async processDailyAll() {
    const { data: rows } = await this.supabase.db
      .from('Subscriptions')
      .select('user_id')
      .eq('is_active', true);

    const userIds = [...new Set((rows ?? []).map((r: { user_id: string }) => r.user_id))];
    for (const userId of userIds) await this.processForUser(userId);
  }
}
