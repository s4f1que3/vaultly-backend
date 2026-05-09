import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
import type { User } from '@supabase/supabase-js';
import { SavingsPotsService } from './savings-pots.service';
import { CreateSavingsPotDto, UpdateSavingsPotDto } from './savings-pots.dto';
import { AuthGuard } from '../common/guards/auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';

@Controller('savings-pots')
@UseGuards(AuthGuard)
export class SavingsPotsController {
  constructor(private readonly service: SavingsPotsService) {}

  @Get()
  findAll(@CurrentUser() user: User) {
    return this.service.findAll(user.id);
  }

  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateSavingsPotDto) {
    return this.service.create(user.id, dto);
  }

  @Patch(':id')
  update(@CurrentUser() user: User, @Param('id') id: string, @Body() dto: UpdateSavingsPotDto) {
    return this.service.update(user.id, id, dto);
  }

  @Delete(':id')
  delete(@CurrentUser() user: User, @Param('id') id: string) {
    return this.service.delete(user.id, id);
  }

  // ── Savings Rules ──────────────────────────────────────────────────────────

  @Get('rules')
  getRules(@CurrentUser() user: User) { return this.service.getRules(user.id); }

  @Post('rules')
  createRule(@CurrentUser() user: User, @Body() body: {
    pot_id: string; name: string; trigger_type: string;
    amount?: number; percentage?: number; day_of_month?: number;
  }) {
    return this.service.createRule(user.id, body);
  }

  @Patch('rules/:id')
  updateRule(@CurrentUser() user: User, @Param('id') id: string, @Body() body: object) {
    return this.service.updateRule(user.id, id, body);
  }

  @Delete('rules/:id')
  deleteRule(@CurrentUser() user: User, @Param('id') id: string) {
    return this.service.deleteRule(user.id, id);
  }
}
