import { mkdirSync } from 'fs';
import pino from 'pino';
import { env } from './env.js';

mkdirSync('logs', { recursive: true });

export const log = pino(
  {
    level: env.LOG_LEVEL,
    base: {
      service: 'sdr-agent',
      env: env.NODE_ENV
    },
    timestamp: pino.stdTimeFunctions.isoTime
  },
  pino.multistream([
    { stream: process.stdout },
    { stream: pino.destination({ dest: 'logs/app.log', sync: false }) }
  ])
);
