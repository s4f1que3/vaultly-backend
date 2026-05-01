import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import express from 'express';
import helmet from 'helmet';
import { AppModule } from '../src/app.module';

const expressServer = express();

// Bootstrap once per container — reused across warm invocations
const appReady = NestFactory.create(
  AppModule,
  new ExpressAdapter(expressServer),
  { rawBody: true, logger: ['error', 'warn'] },
).then(async (app) => {
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));

  app.enableCors({
    origin: process.env.FRONTEND_URL || 'https://vaultly.cash',
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  app.setGlobalPrefix('api');
  await app.init();
});

export default async (req: express.Request, res: express.Response) => {
  await appReady;
  expressServer(req, res);
};
