import { Controller, Get, Patch, Body, UseGuards } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { AuthGuard } from '../common/guards/auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import type { User } from '@supabase/supabase-js';

@Controller('settings')
@UseGuards(AuthGuard)
export class SettingsController {
  constructor(private readonly service: SettingsService) {}

  @Get()
  get(@CurrentUser() user: User) { return this.service.get(user.id); }

  @Patch()
  update(@CurrentUser() user: User, @Body() body: Record<string, unknown>) {
    return this.service.update(user.id, body);
  }
}
