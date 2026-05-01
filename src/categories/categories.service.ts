import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';

const DEFAULT_CATEGORIES = [
  { name: 'food',          icon: '🍔', color: '#f59e0b' },
  { name: 'transport',     icon: '🚗', color: '#3b82f6' },
  { name: 'shopping',      icon: '🛍️', color: '#ec4899' },
  { name: 'entertainment', icon: '🎬', color: '#8b5cf6' },
  { name: 'health',        icon: '💊', color: '#10b981' },
  { name: 'utilities',     icon: '⚡', color: '#06b6d4' },
  { name: 'housing',       icon: '🏠', color: '#f97316' },
  { name: 'education',     icon: '📚', color: '#6366f1' },
  { name: 'salary',        icon: '💰', color: '#57c93c' },
  { name: 'investment',    icon: '📈', color: '#14b8a6' },
  { name: 'transfer',      icon: '🔄', color: '#9c9585' },
  { name: 'other',         icon: '📦', color: '#5c5648' },
  { name: 'general',       icon: '🗂️', color: '#94a3b8' },
];

@Injectable()
export class CategoriesService {
  // In-process cache: userId → Map<slug, uuid>
  private cache = new Map<string, Map<string, string>>();

  constructor(private readonly supabase: SupabaseService) {}

  async findAll(userId: string) {
    const { data, error } = await this.supabase.db
      .from('Categories')
      .select('*')
      .eq('user_id', userId)
      .order('name');
    if (error) throw new Error(error.message);
    return { data };
  }

  /** Returns the UUID for a category slug, creating the row if needed. */
  async resolveId(userId: string, slug: string): Promise<string> {
    const userCache = this.cache.get(userId);
    if (userCache?.has(slug)) return userCache.get(slug)!;

    await this.ensureDefaults(userId);
    return this.cache.get(userId)?.get(slug) ?? await this.createCategory(userId, slug);
  }

  /** Returns the slug (name) for a category UUID, or the UUID itself as fallback. */
  async resolveSlug(userId: string, categoryId: string): Promise<string> {
    await this.ensureDefaults(userId);
    const userCache = this.cache.get(userId);
    for (const [slug, id] of userCache ?? []) {
      if (id === categoryId) return slug;
    }
    return categoryId;
  }

  /** Seeds the 12 default categories for a user if they don't exist yet. */
  async ensureDefaults(userId: string): Promise<void> {
    if (this.cache.has(userId)) return;

    const { data: existing } = await this.supabase.db
      .from('Categories')
      .select('id, name')
      .eq('user_id', userId);

    const existingMap = new Map<string, string>(
      (existing ?? []).map((c: { id: string; name: string }) => [c.name, c.id]),
    );

    const missing = DEFAULT_CATEGORIES.filter(c => !existingMap.has(c.name));

    if (missing.length > 0) {
      const { data: created } = await this.supabase.db
        .from('Categories')
        .insert(missing.map(c => ({ ...c, user_id: userId, is_default: true })))
        .select('id, name');

      for (const row of created ?? []) {
        existingMap.set(row.name, row.id);
      }
    }

    this.cache.set(userId, existingMap);
  }

  private async createCategory(userId: string, slug: string): Promise<string> {
    const defaults = DEFAULT_CATEGORIES.find(c => c.name === slug) ?? {
      name: slug, icon: '📦', color: '#5c5648',
    };
    const { data } = await this.supabase.db
      .from('Categories')
      .insert({ ...defaults, user_id: userId, is_default: false })
      .select('id')
      .single();
    const id = data?.id as string;
    this.cache.get(userId)?.set(slug, id);
    return id;
  }
}
