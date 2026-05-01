import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard } from '../common/guards/auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import { IntelligenceService } from './intelligence.service';
import { CategorySuggestDto, ProjectionsQueryDto, SimulateDto } from './intelligence.dto';
import type { User } from '@supabase/supabase-js';

@Controller('intelligence')
@UseGuards(AuthGuard)
export class IntelligenceController {
  constructor(private readonly intelligence: IntelligenceService) {}

  /** Running safe-to-spend number updated in real-time */
  @Get('safe-to-spend')
  getSafeToSpend(@CurrentUser() user: User) {
    return this.intelligence.getSafeToSpend(user.id);
  }

  /** What-if decision simulator: "if I buy X, what happens?" */
  @Post('simulate')
  simulate(@CurrentUser() user: User, @Body() dto: SimulateDto) {
    return this.intelligence.simulate(user.id, dto);
  }

  /** Day-by-day balance projection for the next N days */
  @Get('projections')
  getProjections(@CurrentUser() user: User, @Query() query: ProjectionsQueryDto) {
    return this.intelligence.getProjections(user.id, query.days);
  }

  /** Behavioural insights: weekday patterns, velocity, category trends */
  @Get('insights')
  getInsights(@CurrentUser() user: User) {
    return this.intelligence.getInsights(user.id);
  }

  /** Adaptive budget suggestions based on 3-month spending history */
  @Get('budget-suggestions')
  getBudgetSuggestions(@CurrentUser() user: User) {
    return this.intelligence.getBudgetSuggestions(user.id);
  }

  /** Cash flow intelligence: subscription audit, upcoming bills, income smoothing */
  @Get('cashflow')
  getCashflow(@CurrentUser() user: User) {
    return this.intelligence.getCashflowIntelligence(user.id);
  }

  /** Suggest a category for a merchant name (no auth required for the heuristic) */
  @Post('suggest-category')
  suggestCategory(@CurrentUser() user: User, @Body() dto: CategorySuggestDto) {
    return this.intelligence.resolveMerchantCategory(user.id, dto.merchant);
  }
}
