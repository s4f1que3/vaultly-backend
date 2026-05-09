import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { DebtsService } from './debts.service';
import { AuthGuard } from '../common/guards/auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import type { User } from '@supabase/supabase-js';

@Controller('debts')
@UseGuards(AuthGuard)
export class DebtsController {
  constructor(private readonly service: DebtsService) {}

  @Post('payoff')
  calculatePayoff(
    @CurrentUser() user: User,
    @Body() body: { monthlyBudget: number; strategy: 'avalanche' | 'snowball' },
  ) {
    return this.service.calculatePayoff(user.id, body.monthlyBudget, body.strategy);
  }
}
