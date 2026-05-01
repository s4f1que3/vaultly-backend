import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';

@Injectable()
export class SettingsService {
  constructor(private readonly supabase: SupabaseService) {}

  async get(userId: string) {
    const { data } = await this.supabase.db
      .from('User_settings').select('*').eq('user_id', userId).single();
    return { data: data || this.defaults(userId) };
  }

  async update(userId: string, updates: Record<string, unknown>) {
    const { data: existing } = await this.supabase.db
      .from('User_settings').select('id').eq('user_id', userId).single();

    if (existing) {
      const { data, error } = await this.supabase.db
        .from('User_settings')
        .update(updates)
        .eq('user_id', userId)
        .select().single();
      if (error) throw new Error(error.message);
      return data;
    } else {
      const { data, error } = await this.supabase.db
        .from('User_settings')
        .insert({ ...this.defaults(userId), ...updates })
        .select().single();
      if (error) throw new Error(error.message);
      return data;
    }
  }

  private defaults(userId: string) {
    return {
      user_id: userId,
      currency: 'USD',
      notifications_enabled: true,
      budget_alerts: true,
      goal_reminders: true,
      weekly_summary: true,
      theme: 'dark',
      language: 'en',
    };
  }
}
