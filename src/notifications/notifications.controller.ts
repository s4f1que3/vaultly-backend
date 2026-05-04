import { Controller, Get, Patch, Delete, Post, Body, Param, UseGuards, HttpCode } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { AuthGuard } from '../common/guards/auth.guard';
import { CurrentUser } from '../common/decorators/user.decorator';
import type { User } from '@supabase/supabase-js';
import { z } from 'zod';

const RegisterDeviceDto = z.object({
  token: z.string().min(1),
  deviceType: z.enum(['ios', 'android']),
});

@Controller('notifications')
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get()
  findAll(@CurrentUser() user: User) { return this.service.findAll(user.id); }

  @Patch(':id/read')
  markAsRead(@CurrentUser() user: User, @Param('id') id: string) { return this.service.markAsRead(user.id, id); }

  @Patch('read-all')
  markAllAsRead(@CurrentUser() user: User) { return this.service.markAllAsRead(user.id); }

  @Delete(':id')
  delete(@CurrentUser() user: User, @Param('id') id: string) { return this.service.delete(user.id, id); }

  @Post('subscribe')
  subscribe(
    @CurrentUser() user: User,
    @Body() body: { subscription: { endpoint: string; keys: { p256dh: string; auth: string } } },
  ) {
    return this.service.subscribe(user.id, body.subscription);
  }

  @Post('register-device')
  @HttpCode(201)
  registerDevice(@CurrentUser() user: User, @Body() body: unknown) {
    const { token, deviceType } = RegisterDeviceDto.parse(body);
    return this.service.registerDevice(user.id, token, deviceType);
  }

  @Get('device-tokens')
  getDeviceTokens(@CurrentUser() user: User) {
    return this.service.getUserTokens(user.id);
  }
}
