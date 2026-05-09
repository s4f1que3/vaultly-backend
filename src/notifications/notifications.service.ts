import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SupabaseService } from '../common/supabase.service';
import webpush from 'web-push';

interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

@Injectable()
export class NotificationsService {
  private vapidReady = false;

  constructor(private readonly supabase: SupabaseService) {}

  private initVapid() {
    if (this.vapidReady) return;
    const pub = process.env.VAPID_PUBLIC_KEY;
    const priv = process.env.VAPID_PRIVATE_KEY;
    if (!pub || !priv) return;
    webpush.setVapidDetails('mailto:admin@vaultly.app', pub, priv);
    this.vapidReady = true;
  }

  async findAll(userId: string) {
    const { data, error } = await this.supabase.db
      .from('Notifications')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return { data };
  }

  async markAsRead(userId: string, id: string) {
    const { data, error } = await this.supabase.db
      .from('Notifications')
      .update({ is_read: true })
      .eq('id', id)
      .eq('user_id', userId)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return data;
  }

  async markAllAsRead(userId: string) {
    await this.supabase.db
      .from('Notifications')
      .update({ is_read: true })
      .eq('user_id', userId)
      .eq('is_read', false);
    return { success: true };
  }

  async delete(userId: string, id: string) {
    await this.supabase.db
      .from('Notifications')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);
    return { success: true };
  }

  async subscribe(userId: string, subscription: PushSubscription) {
    // Delete any existing subscription for this user, then insert fresh
    await this.supabase.db
      .from('Push_Subscriptions')
      .delete()
      .eq('user_id', userId);

    const { data } = await this.supabase.db
      .from('Push_Subscriptions')
      .insert({
        user_id: userId,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      })
      .select()
      .single();
    return data;
  }

  async sendPush(userId: string, title: string, body: string, data?: object) {
    this.initVapid();
    if (!this.vapidReady) return;

    const { data: sub } = await this.supabase.db
      .from('Push_Subscriptions')
      .select('endpoint, p256dh, auth')
      .eq('user_id', userId)
      .single();

    if (!sub) return;

    const pushSub: PushSubscription = {
      endpoint: sub.endpoint as string,
      keys: { p256dh: sub.p256dh as string, auth: sub.auth as string },
    };

    try {
      await webpush.sendNotification(pushSub, JSON.stringify({ title, body, data }));
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 410) {
        await this.supabase.db
          .from('Push_Subscriptions')
          .delete()
          .eq('user_id', userId);
      }
    }
  }

  // ── Weekly Digest ─────────────────────────────────────────────────────────
  // Sends every Monday at 8am. Creates a notification + push for each opted-in user.

  @Cron('0 8 * * 1')
  async sendWeeklyDigests() {
    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const weekStart = oneWeekAgo.toISOString().split('T')[0];
    const today = new Date().toISOString().split('T')[0];

    // Get users who have weekly_summary enabled
    const { data: settings } = await this.supabase.db
      .from('User_settings')
      .select('user_id')
      .eq('weekly_summary', true);

    for (const setting of settings ?? []) {
      await this.generateDigestForUser(setting.user_id, weekStart, today);
    }
  }

  async generateDigestForUser(userId: string, weekStart: string, weekEnd: string) {
    const { data: txs } = await this.supabase.db
      .from('Transactions')
      .select('amount, type')
      .eq('user_id', userId)
      .gte('date', weekStart)
      .lte('date', weekEnd);

    const expenses = (txs ?? []).filter((t: { type: string }) => t.type === 'expense');
    const totalSpend = expenses.reduce((s: number, t: { amount: number }) => s + t.amount, 0);
    const transactionCount = expenses.length;

    // Previous week for comparison
    const prevStart = new Date(weekStart);
    prevStart.setDate(prevStart.getDate() - 7);
    const { data: prevTxs } = await this.supabase.db
      .from('Transactions').select('amount, type').eq('user_id', userId).eq('type', 'expense')
      .gte('date', prevStart.toISOString().split('T')[0]).lte('date', weekStart);

    const prevSpend = (prevTxs ?? []).reduce((s: number, t: { amount: number }) => s + t.amount, 0);
    const diff = prevSpend > 0 ? ((totalSpend - prevSpend) / prevSpend) * 100 : 0;
    const trend = diff > 10 ? `↑ ${diff.toFixed(0)}% more` : diff < -10 ? `↓ ${Math.abs(diff).toFixed(0)}% less` : 'about the same';

    const title = 'Your Weekly Digest';
    const body = `You spent $${totalSpend.toFixed(2)} across ${transactionCount} transaction${transactionCount !== 1 ? 's' : ''} — ${trend} than last week.`;

    // In-app notification
    await this.supabase.db.from('Notifications').insert({
      user_id: userId, type: 'system', title, body, is_read: false,
    });

    // Push notification
    await this.sendPush(userId, title, body);
  }

  async registerDevice(userId: string, token: string, deviceType: string) {
    const { error } = await this.supabase.db
      .from('device_tokens')
      .upsert({
        user_id: userId,
        expo_push_token: token,
        device_type: deviceType,
        push_notifications_enabled: true,
        updated_at: new Date().toISOString(),
      }, {
        onConflict: 'user_id,expo_push_token'
      });
    
    if (error) throw new Error(error.message);
    return { success: true, message: 'Device registered successfully' };
  }

  async getUserTokens(userId: string) {
    const { data, error } = await this.supabase.db
      .from('device_tokens')
      .select('*')
      .eq('user_id', userId)
      .eq('push_notifications_enabled', true);
    
    if (error) throw new Error(error.message);
    return { data: data || [] };
  }
}
