import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import type { User } from '@supabase/supabase-js';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './categories.dto';
import { AuthGuard } from '../common/guards/auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';

@Controller('categories')
@UseGuards(AuthGuard)
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get()
  findAll(@CurrentUser() user: User) {
    return this.categoriesService.findAll(user.id);
  }

  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateCategoryDto) {
    return this.categoriesService.createCustom(user.id, dto.label, dto.emoji);
  }
}
