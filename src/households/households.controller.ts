import { Controller, Get, Post, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { HouseholdsService } from './households.service';
import { AuthGuard } from '../common/guards/auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import type { User } from '@supabase/supabase-js';

@Controller('households')
@UseGuards(AuthGuard)
export class HouseholdsController {
  constructor(private readonly service: HouseholdsService) {}

  @Get()
  getMyHousehold(@CurrentUser() user: User) { return this.service.getMyHousehold(user.id); }

  @Get('invites')
  getMyInvites(@CurrentUser() user: User) { return this.service.getMyInvites(user.id); }

  @Post()
  createHousehold(@CurrentUser() user: User, @Body() body: { name: string }) {
    return this.service.createHousehold(user.id, body.name);
  }

  @Post('invite')
  inviteMember(@CurrentUser() user: User, @Body() body: { email: string }) {
    return this.service.inviteMember(user.id, body.email);
  }

  @Post('invites/:id/accept')
  acceptInvite(@CurrentUser() user: User, @Param('id') id: string) {
    return this.service.acceptInvite(user.id, id);
  }

  @Post('invites/:id/decline')
  declineInvite(@Param('id') id: string) {
    return this.service.declineInvite(id);
  }

  @Post('leave')
  leaveHousehold(@CurrentUser() user: User) { return this.service.leaveHousehold(user.id); }

  @Delete()
  deleteHousehold(@CurrentUser() user: User) { return this.service.deleteHousehold(user.id); }

  @Delete('members/:userId')
  removeMember(@CurrentUser() user: User, @Param('userId') memberId: string) {
    return this.service.removeMember(user.id, memberId);
  }
}
