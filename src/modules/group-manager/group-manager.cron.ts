import cron, { type ScheduledTask } from 'node-cron';
import { env } from '../../config/env.js';
import { log } from '../../config/logger.js';
import { generateDailyNewsDigest } from './group-manager.service.js';
import { sendWhatsAppGroupText, WhatsAppDeliveryError } from '../../integrations/whatsapp/qr.client.js';

let scheduledTask: ScheduledTask | null = null;
let lastSentDateKey: string | null = null;

function dateKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function isValidCronExpression(expr: string): boolean {
  return cron.validate(expr);
}

async function runDailyNewsJob(): Promise<void> {
  const today = dateKey();
  if (lastSentDateKey === today) {
    log.debug({ date: today }, 'Job de noticias diarias ja executou hoje; pulando');
    return;
  }
  const targetGroup = env.GROUP_MANAGER_TARGET_GROUP_ID;
  if (!targetGroup) {
    log.warn('Job de noticias diarias sem GROUP_MANAGER_TARGET_GROUP_ID configurado');
    return;
  }

  try {
    const digest = await generateDailyNewsDigest();
    await sendWhatsAppGroupText(targetGroup, digest.text);
    lastSentDateKey = today;
    log.info(
      { groupId: targetGroup, sources: digest.sources },
      'Resumo diario de noticias enviado ao grupo'
    );
  } catch (err) {
    if (err instanceof WhatsAppDeliveryError) {
      log.warn(
        { groupId: targetGroup, code: err.code, reason: err.message },
        'Resumo diario nao entregue; worker seguira tentando no proximo ciclo'
      );
    } else {
      log.error({ err, groupId: targetGroup }, 'Falha ao enviar resumo diario de noticias');
    }
  }
}

export function startGroupManagerCron(): void {
  if (!env.GROUP_MANAGER_ENABLED) {
    log.info('Group Manager desabilitado (GROUP_MANAGER_ENABLED=false); cron nao iniciado');
    return;
  }
  if (scheduledTask) return;

  const expression = env.GROUP_MANAGER_NEWS_CRON;
  if (!isValidCronExpression(expression)) {
    log.error({ expression }, 'Cron expression invalida; job nao foi agendado');
    return;
  }

  scheduledTask = cron.schedule(
    expression,
    () => {
      void runDailyNewsJob();
    },
    { timezone: env.GROUP_MANAGER_NEWS_TIMEZONE }
  );

  log.info(
    { expression, timezone: env.GROUP_MANAGER_NEWS_TIMEZONE, groupId: env.GROUP_MANAGER_TARGET_GROUP_ID },
    'Cron do Group Manager iniciado (noticias diarias)'
  );
}

export function stopGroupManagerCron(): void {
  if (!scheduledTask) return;
  scheduledTask.stop();
  scheduledTask = null;
  log.info('Cron do Group Manager parado');
}

export function runGroupManagerNewsNow(): Promise<void> {
  return runDailyNewsJob();
}
