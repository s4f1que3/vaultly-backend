import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { AppService } from './app.service';
import { SupabaseService } from './common/supabase.service';
import { Public } from './common/decorators/public.decorator';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly supabase: SupabaseService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  @Public()
  async getHealth() {
    try {
      // Check database connectivity
      const { error } = await this.supabase.db
        .from('Notifications')
        .select('count')
        .limit(1);

      if (error) {
        throw new HttpException(
          {
            status: 'error',
            message: 'Database connection failed',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }

      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      };
    } catch (err) {
      throw new HttpException(
        {
          status: 'error',
          message: 'Health check failed',
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}
