import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { GoalsService } from './goals.service';
import { CreateGoalDto, UpdateGoalDto, ContributeDto } from './goals.dto';
import { AuthGuard } from '../common/guards/auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import type { User } from '@supabase/supabase-js';

@Controller('goals')
@UseGuards(AuthGuard)
export class GoalsController {
  constructor(private readonly service: GoalsService) {}

  @Get()
  findAll(@CurrentUser() user: User) { return this.service.findAll(user.id); }

  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateGoalDto) { return this.service.create(user.id, dto); }

  @Patch(':id')
  update(@CurrentUser() user: User, @Param('id') id: string, @Body() dto: UpdateGoalDto) { return this.service.update(user.id, id, dto); }

  @Delete(':id')
  delete(@CurrentUser() user: User, @Param('id') id: string) { return this.service.delete(user.id, id); }

  @Post(':id/contribute')
  contribute(@CurrentUser() user: User, @Param('id') id: string, @Body() dto: ContributeDto) { return this.service.contribute(user.id, id, dto); }
}
