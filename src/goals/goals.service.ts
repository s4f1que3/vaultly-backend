import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';
import { CreateGoalDto, UpdateGoalDto, ContributeDto } from './goals.dto';

@Injectable()
export class GoalsService {
  constructor(private readonly supabase: SupabaseService) {}

  async findAll(userId: string) {
    const { data, error } = await this.supabase.db
      .from('Savings').select('*').eq('user_id', userId).order('created_at');
    if (error) throw new BadRequestException(error.message);
    return { data };
  }

  async create(userId: string, dto: CreateGoalDto) {
    const { data, error } = await this.supabase.db
      .from('Savings')
      .insert({ ...dto, user_id: userId, current_amount: dto.current_amount || 0, status: 'active' })
      .select().single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  async update(userId: string, id: string, dto: UpdateGoalDto) {
    const { data: existing } = await this.supabase.db
      .from('Savings').select('*').eq('id', id).eq('user_id', userId).single();
    if (!existing) throw new NotFoundException('Goal not found');

    const { data, error } = await this.supabase.db
      .from('Savings').update({ ...dto }).eq('id', id).eq('user_id', userId).select().single();
    if (error) throw new BadRequestException(error.message);
    return data;
  }

  async delete(userId: string, id: string) {
    const { error } = await this.supabase.db
      .from('Savings').delete().eq('id', id).eq('user_id', userId);
    if (error) throw new BadRequestException(error.message);
  }

  async contribute(userId: string, id: string, dto: ContributeDto) {
    const { data: goal } = await this.supabase.db
      .from('Savings').select('*').eq('id', id).eq('user_id', userId).single();
    if (!goal) throw new NotFoundException('Goal not found');

    const newAmount = goal.current_amount + dto.amount;
    const isCompleted = newAmount >= goal.target_amount;

    const { data, error } = await this.supabase.db
      .from('Savings')
      .update({ current_amount: newAmount, status: isCompleted ? 'completed' : 'active' })
      .eq('id', id)
      .eq('user_id', userId)
      .select().single();

    if (error) throw new BadRequestException(error.message);

    if (isCompleted) {
      await this.supabase.db.from('Notifications').insert({
        user_id: userId,
        type: 'goal_achieved',
        title: `Goal Achieved! 🎉`,
        body: `Congratulations! You've reached your "${goal.name}" savings goal of ${goal.target_amount}!`,
        is_read: false,
      });
    }

    return data;
  }
}
