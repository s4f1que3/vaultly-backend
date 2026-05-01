import { Controller, Get, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { SummariesService } from './summaries.service';
import type { User } from '@supabase/supabase-js';

@Controller('summaries')
@UseGuards(AuthGuard)
export class SummariesController {
  constructor(private readonly service: SummariesService) {}

  /** All months and years that have transaction data — drives the period picker in the UI */
  @Get('periods')
  getPeriods(@CurrentUser() user: User) {
    return this.service.getAvailablePeriods(user.id);
  }

  /** Full monthly summary: GET /api/summaries/monthly?month=4&year=2026 */
  @Get('monthly')
  getMonthly(
    @CurrentUser() user: User,
    @Query('month') month?: string,
    @Query('year') year?: string,
  ) {
    const now = new Date();
    const m = month ? parseInt(month) : now.getMonth() + 1;
    const y = year ? parseInt(year) : now.getFullYear();
    if (m < 1 || m > 12) throw new BadRequestException('month must be 1–12');
    return this.service.getMonthlySummary(user.id, m, y);
  }

  /** Full yearly summary: GET /api/summaries/yearly?year=2026 */
  @Get('yearly')
  getYearly(
    @CurrentUser() user: User,
    @Query('year') year?: string,
  ) {
    const y = year ? parseInt(year) : new Date().getFullYear();
    return this.service.getYearlySummary(user.id, y);
  }
}
