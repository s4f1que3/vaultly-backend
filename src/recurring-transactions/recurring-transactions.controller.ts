import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { RecurringTransactionsService } from './recurring-transactions.service';
import { CreateRecurringTransactionDto, UpdateRecurringTransactionDto } from './recurring-transactions.dto';
import { AuthGuard } from '../common/guards/auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import type { User } from '@supabase/supabase-js';

@Controller('recurring-transactions')
@UseGuards(AuthGuard)
export class RecurringTransactionsController {
  constructor(private readonly service: RecurringTransactionsService) {}

  @Get()
  findAll(@CurrentUser() user: User) { return this.service.findAll(user.id); }

  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateRecurringTransactionDto) {
    return this.service.create(user.id, dto);
  }

  @Patch(':id')
  update(@CurrentUser() user: User, @Param('id') id: string, @Body() dto: UpdateRecurringTransactionDto) {
    return this.service.update(user.id, id, dto);
  }

  @Delete(':id')
  delete(@CurrentUser() user: User, @Param('id') id: string) {
    return this.service.delete(user.id, id);
  }

  @Post('process')
  processNow(@CurrentUser() user: User) { return this.service.processForUser(user.id); }
}
