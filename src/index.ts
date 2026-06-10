import 'dotenv/config';
import { validateEnv, env } from './config/env.js';
import { log } from './config/logger.js';
import { checkConnection, closeDatabase, runMigrations } from './db/client.js';
import { startWhatsAppQr, stopWhatsAppQr } from './integrations/whatsapp/qr.client.js';
import { handleInboundMessage } from './modules/conversation/conversation.service.js';
import { startGroupManagerCron, stopGroupManagerCron } from './modules/group-manager/group-manager.cron.js';
import { handleGroupInboundMessage } from './modules/group-manager/group-manager.service.js';
import { ingestCsvText } from './modules/ingestion/ingestion.service.js';
import { startOutboundDeliveryWorker, stopOutboundDeliveryWorker } from './modules/personalization/personalization.service.js';
import { startResearchWorker, stopResearchWorker } from './modules/research/research.service.js';
import { startServer } from './server/server.js';
import { syncVectorDatabase } from './db/vector.js';

process.on('unhandledRejection', (reason) => {
  log.error({ err: reason }, 'Promise rejeitada sem tratamento; processo mantido em execucao');
});

process.on('uncaughtException', (err) => {
  log.error({ err }, 'Excecao nao tratada; processo mantido em execucao');
});

async function main(): Promise<void> {
  validateEnv();
  log.info({ env: env.NODE_ENV }, 'Variaveis de ambiente validadas');

  await runMigrations();
  await checkConnection();

  void syncVectorDatabase().catch((err) => {
    log.error({ err }, 'Falha ao sincronizar banco vetorial na inicializacao');
  });

  await startWhatsAppQr({
    onInbound: handleInboundMessage,
    onAdminCsv: ingestCsvText,
    onGroupInbound: handleGroupInboundMessage
  });
  log.info('WhatsApp QR iniciado. Escaneie o QR Code no terminal quando aparecer.');
  startResearchWorker();
  startOutboundDeliveryWorker();
  startGroupManagerCron();

  const server = await startServer();
  await server.listen({ port: env.PORT, host: '0.0.0.0' });
  log.info({ port: env.PORT }, 'SDR Agent rodando');

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Iniciando shutdown graceful...');
    stopGroupManagerCron();
    stopResearchWorker();
    stopOutboundDeliveryWorker();
    await server.close();
    await stopWhatsAppQr();
    await closeDatabase();
    process.exit(0);
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

main().catch((err) => {
  console.error('Falha fatal na inicializacao:', err);
  process.exit(1);
});
