import { BadRequestException, Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../common/supabase.service';
import { EmailService } from '../licenses/email.service';

@Injectable()
export class HouseholdsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  async getMyHousehold(userId: string) {
    // User may be owner or member
    const { data: membership } = await this.supabase.db
      .from('household_members')
      .select('household_id, role')
      .eq('user_id', userId)
      .single();

    if (!membership) return { household: null, members: [], invites: [] };

    const { data: household } = await this.supabase.db
      .from('households').select('*').eq('id', membership.household_id).single();

    const { data: members } = await this.supabase.db
      .from('household_members')
      .select('id, user_id, role, joined_at')
      .eq('household_id', membership.household_id);

    const { data: invites } = await this.supabase.db
      .from('household_invites')
      .select('*')
      .eq('household_id', membership.household_id)
      .eq('status', 'pending');

    return { household, members: members ?? [], invites: invites ?? [], role: membership.role };
  }

  async createHousehold(userId: string, name: string) {
    // Check user is not already in a household
    const { data: existing } = await this.supabase.db
      .from('household_members').select('id').eq('user_id', userId).single();
    if (existing) throw new BadRequestException('You are already part of a household');

    const { data: household, error } = await this.supabase.db
      .from('households').insert({ owner_id: userId, name }).select().single();
    if (error) throw new BadRequestException(error.message);

    await this.supabase.db.from('household_members').insert({
      household_id: (household as { id: string }).id,
      user_id: userId,
      role: 'owner',
    });

    return household;
  }

  async inviteMember(userId: string, email: string) {
    const { data: membership } = await this.supabase.db
      .from('household_members').select('household_id, role').eq('user_id', userId).single();
    if (!membership) throw new NotFoundException('You are not part of a household');
    if (membership.role !== 'owner') throw new ForbiddenException('Only the owner can invite members');

    const { data, error } = await this.supabase.db
      .from('household_invites')
      .upsert({
        household_id: membership.household_id,
        invited_email: email.toLowerCase(),
        invited_by: userId,
        status: 'pending',
      }, { onConflict: 'household_id,invited_email' })
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);

    // Fetch inviter name and household name for the email
    const [inviterRes, householdRes] = await Promise.all([
      this.supabase.db.auth.admin.getUserById(userId),
      this.supabase.db.from('households').select('name').eq('id', membership.household_id).single(),
    ]);

    const inviterName = inviterRes.data?.user?.user_metadata?.full_name
      || inviterRes.data?.user?.email?.split('@')[0]
      || 'Someone';
    const householdName = (householdRes.data as { name: string } | null)?.name ?? 'a household';
    const frontendUrl = this.config.get<string>('FRONTEND_URL') ?? 'https://vaultly.cash';

    // Fire-and-forget — don't block the response if email fails
    this.email.sendHouseholdInvite(email.toLowerCase(), inviterName, householdName, frontendUrl);

    return data;
  }

  async acceptInvite(userId: string, inviteId: string) {
    const { data: invite } = await this.supabase.db
      .from('household_invites').select('*').eq('id', inviteId).eq('status', 'pending').single();
    if (!invite) throw new NotFoundException('Invite not found or already used');

    // Check user isn't already in a household
    const { data: existing } = await this.supabase.db
      .from('household_members').select('id').eq('user_id', userId).single();
    if (existing) throw new BadRequestException('You are already part of a household');

    await this.supabase.db.from('household_members').insert({
      household_id: invite.household_id,
      user_id: userId,
      role: 'member',
    });

    await this.supabase.db
      .from('household_invites').update({ status: 'accepted' }).eq('id', inviteId);

    return { success: true };
  }

  async declineInvite(inviteId: string) {
    await this.supabase.db
      .from('household_invites').update({ status: 'declined' }).eq('id', inviteId);
    return { success: true };
  }

  async leaveHousehold(userId: string) {
    const { data: membership } = await this.supabase.db
      .from('household_members').select('household_id, role').eq('user_id', userId).single();
    if (!membership) throw new NotFoundException('You are not part of a household');
    if (membership.role === 'owner') throw new BadRequestException('Owner cannot leave — delete the household instead');

    await this.supabase.db.from('household_members').delete().eq('user_id', userId);
    return { success: true };
  }

  async deleteHousehold(userId: string) {
    const { data: membership } = await this.supabase.db
      .from('household_members').select('household_id, role').eq('user_id', userId).single();
    if (!membership) throw new NotFoundException('You are not part of a household');
    if (membership.role !== 'owner') throw new ForbiddenException('Only the owner can delete the household');

    await this.supabase.db.from('households').delete().eq('id', membership.household_id);
    return { success: true };
  }

  async removeMember(ownerId: string, memberUserId: string) {
    const { data: ownerMembership } = await this.supabase.db
      .from('household_members').select('household_id, role').eq('user_id', ownerId).single();
    if (!ownerMembership || ownerMembership.role !== 'owner') throw new ForbiddenException('Only the owner can remove members');

    await this.supabase.db
      .from('household_members')
      .delete()
      .eq('user_id', memberUserId)
      .eq('household_id', ownerMembership.household_id);

    return { success: true };
  }

  // Pending invites for the current user's email
  async getMyInvites(userId: string) {
    const { data: userData } = await this.supabase.db
      .auth.admin.getUserById(userId);
    const email = userData?.user?.email;
    if (!email) return { data: [] };

    const { data } = await this.supabase.db
      .from('household_invites')
      .select('*, household:households(name)')
      .eq('invited_email', email.toLowerCase())
      .eq('status', 'pending');

    return { data: data ?? [] };
  }
}
