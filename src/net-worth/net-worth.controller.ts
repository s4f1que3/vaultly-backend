import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { NetWorthService } from './net-worth.service';
import { CreateLiabilityDto, UpdateLiabilityDto } from './net-worth.dto';
import { AuthGuard } from '../common/guards/auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import type { User } from '@supabase/supabase-js';

@Controller('net-worth')
@UseGuards(AuthGuard)
export class NetWorthController {
  constructor(private readonly service: NetWorthService) {}

  @Get()
  getNetWorth(@CurrentUser() user: User) { return this.service.getNetWorth(user.id); }

  @Get('liabilities')
  getLiabilities(@CurrentUser() user: User) { return this.service.getLiabilities(user.id); }

  @Post('liabilities')
  createLiability(@CurrentUser() user: User, @Body() dto: CreateLiabilityDto) {
    return this.service.createLiability(user.id, dto);
  }

  @Patch('liabilities/:id')
  updateLiability(@CurrentUser() user: User, @Param('id') id: string, @Body() dto: UpdateLiabilityDto) {
    return this.service.updateLiability(user.id, id, dto);
  }

  @Delete('liabilities/:id')
  deleteLiability(@CurrentUser() user: User, @Param('id') id: string) {
    return this.service.deleteLiability(user.id, id);
  }
}
