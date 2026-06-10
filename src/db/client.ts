import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { log } from '../config/logger.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

export const prisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error']
});

export async function runMigrations(): Promise<void> {
  const prismaCli = require.resolve('prisma/build/index.js');
  await execFileAsync(process.execPath, [prismaCli, 'db', 'push', '--skip-generate'], {
    cwd: process.cwd(),
    windowsHide: true
  });

  await prisma.tenant.upsert({
    where: { tenant_id: env.DEFAULT_TENANT_ID },
    update: {
      agent_name: env.DEFAULT_AGENT_NAME,
      service_category: env.DEFAULT_SERVICE_CATEGORY,
      active: true
    },
    create: {
      tenant_id: env.DEFAULT_TENANT_ID,
      name: 'SDR Local',
      whatsapp_number_id: 'local-qr',
      agent_name: env.DEFAULT_AGENT_NAME,
      service_category: env.DEFAULT_SERVICE_CATEGORY
    }
  });

  log.info('Banco Prisma/SQLite pronto');
}

export async function checkConnection(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
  log.info('Banco local Prisma conectado');
}

export async function closeDatabase(): Promise<void> {
  await prisma.$disconnect();
}
