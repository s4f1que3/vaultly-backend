import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { BudgetsService } from './budgets.service';
import { CreateBudgetDto, UpdateBudgetDto } from './budgets.dto';
import { AuthGuard } from '../common/guards/auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import type { User } from '@supabase/supabase-js';

@Controller('budgets')
@UseGuards(AuthGuard)
export class BudgetsController {
  constructor(private readonly service: BudgetsService) {}

  @Get()
  findAll(@CurrentUser() user: User) { return this.service.findAll(user.id); }

  @Get('history')
  getHistory(@CurrentUser() user: User, @Query('months') months?: string) {
    return this.service.getHistory(user.id, months ? parseInt(months) : 6);
  }

  @Post('rollover')
  rollover(@CurrentUser() user: User) { return this.service.rolloverForUser(user.id); }

  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateBudgetDto) { return this.service.create(user.id, dto); }

  @Patch(':id')
  update(@CurrentUser() user: User, @Param('id') id: string, @Body() dto: UpdateBudgetDto) { return this.service.update(user.id, id, dto); }

  @Delete(':id')
  delete(@CurrentUser() user: User, @Param('id') id: string) { return this.service.delete(user.id, id); }
}
