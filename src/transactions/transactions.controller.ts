import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, UseGuards,
} from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { CreateTransactionDto, UpdateTransactionDto, TransactionQueryDto } from './transactions.dto';
import { AuthGuard } from '../common/guards/auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import type { User } from '@supabase/supabase-js';

@Controller('transactions')
@UseGuards(AuthGuard)
export class TransactionsController {
  constructor(private readonly service: TransactionsService) {}

  @Get()
  findAll(@CurrentUser() user: User, @Query() query: TransactionQueryDto) {
    return this.service.findAll(user.id, query);
  }

  @Post('import/preview')
  importPreview(@CurrentUser() user: User, @Body() body: { csv: string }) {
    return this.service.previewImport(user.id, body.csv);
  }

  @Post('import/confirm')
  importConfirm(@CurrentUser() user: User, @Body() body: { rows: object[] }) {
    return this.service.confirmImport(user.id, body.rows as never);
  }

  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateTransactionDto) {
    return this.service.create(user.id, dto);
  }

  @Patch(':id')
  update(@CurrentUser() user: User, @Param('id') id: string, @Body() dto: UpdateTransactionDto) {
    return this.service.update(user.id, id, dto);
  }

  @Delete(':id')
  delete(@CurrentUser() user: User, @Param('id') id: string) {
    return this.service.delete(user.id, id);
  }

  @Get(':id/splits')
  getSplits(@CurrentUser() user: User, @Param('id') id: string) {
    return this.service.getSplits(user.id, id);
  }

  @Post(':id/splits')
  setSplits(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: { splits: { category: string; amount: number; note?: string }[] },
  ) {
    return this.service.setSplits(user.id, id, body.splits);
  }

  @Delete(':id/splits')
  deleteSplits(@CurrentUser() user: User, @Param('id') id: string) {
    return this.service.deleteSplits(user.id, id);
  }
}
