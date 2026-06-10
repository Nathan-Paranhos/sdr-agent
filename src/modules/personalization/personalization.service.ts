import { z } from 'zod';
import { env } from '../../config/env.js';
import { log } from '../../config/logger.js';
import { prisma } from '../../db/client.js';
import { parseStringArray } from '../../db/utils.js';
import { callLLM, parseJsonResponse } from '../../integrations/groq/llm.client.js';
import { sendWhatsAppText, WhatsAppDeliveryError } from '../../integrations/whatsapp/qr.client.js';
import { buildMessageUserContent, MESSAGE_SYSTEM_PROMPT } from './message.prompt.js';

const MessageResponseSchema = z.object({
  message: z.string().min(10).max(1000)
});

const OUTBOUND_DELIVERY_INTERVAL_MS = 30_000;
const OUTBOUND_DELIVERY_BATCH_SIZE = 10;

let outboundDeliveryTimer: NodeJS.Timeout | null = null;
let outboundDeliveryRunning = false;

export function calculateHumanizedDelayMs(): number {
  const mean = 10 * 60 * 1000;
  const std = 5 * 60 * 1000;
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(3 * 60 * 1000, Math.min(25 * 60 * 1000, mean + z * std));
}

export function isWithinSendWindow(date: Date = new Date()): boolean {
  const day = date.getDay();
  const hhmm = date.getHours() * 100 + date.getMinutes();
  if (day === 0) return false;
  if (day === 6) return hhmm >= 900 && hhmm < 1200;
  return hhmm >= 800 && hhmm < 1830;
}

export function nextValidSendTime(): Date {
  const now = new Date();
  const candidate = new Date(now.getTime() + calculateHumanizedDelayMs());
  if (isWithinSendWindow(candidate)) return candidate;

  const next = new Date(candidate);
  next.setHours(8, 0, 0, 0);
  next.setDate(next.getDate() + 1);
  while (!isWithinSendWindow(new Date(next.getTime() + 60_000))) {
    next.setDate(next.getDate() + 1);
  }
  return new Date(next.getTime() + calculateHumanizedDelayMs());
}

export async function sendOutboundMessage(messageId: string): Promise<'sent' | 'failed' | 'skipped' | 'deferred'> {
  const outbound = await prisma.outboundMessage.findFirst({
    where: { message_id: messageId, delivery_status: 'scheduled' },
    include: { lead: true }
  });
  if (!outbound) return 'skipped';

  try {
    const whatsappId = await sendWhatsAppText(outbound.lead.phone, outbound.body);
    await prisma.outboundMessage.update({
      where: { message_id: messageId },
      data: {
        sent_at: new Date(),
        delivery_status: 'sent',
        whatsapp_msg_id: whatsappId
      }
    });
    await prisma.message.create({
      data: {
        lead_id: outbound.lead_id,
        role: 'agent',
        body: outbound.body,
        whatsapp_id: whatsappId
      }
    });
    await prisma.lead.update({
      where: { lead_id: outbound.lead_id },
      data: { conversation_status: 'active', last_message_at: new Date() }
    });
    return 'sent';
  } catch (err) {
    if (err instanceof WhatsAppDeliveryError) {
      if (err.code === 'not_ready') {
        log.warn(
          { leadId: outbound.lead_id, phone: err.phone, reason: err.message },
          'Envio adiado porque o WhatsApp ainda nao esta pronto'
        );
        return 'deferred';
      }

      await prisma.outboundMessage.update({
        where: { message_id: messageId },
        data: { delivery_status: 'failed' }
      });
      log.warn(
        { leadId: outbound.lead_id, phone: err.phone, code: err.code, reason: err.message },
        'Mensagem nao entregue pelo WhatsApp'
      );
      return 'failed';
    }

    await prisma.outboundMessage.update({
      where: { message_id: messageId },
      data: { delivery_status: 'failed' }
    });
    log.error({ err, leadId: outbound.lead_id }, 'Falha inesperada ao enviar mensagem WhatsApp');
    return 'failed';
  }
}

export async function flushDueOutboundMessages(limit = OUTBOUND_DELIVERY_BATCH_SIZE): Promise<void> {
  if (outboundDeliveryRunning) return;
  outboundDeliveryRunning = true;

  try {
    const dueMessages = await prisma.outboundMessage.findMany({
      where: {
        delivery_status: 'scheduled',
        scheduled_at: { lte: new Date() }
      },
      orderBy: { scheduled_at: 'asc' },
      take: limit,
      select: { message_id: true, lead_id: true }
    });

    for (const due of dueMessages) {
      try {
        await sendOutboundMessage(due.message_id);
      } catch (err) {
        log.error({ err, leadId: due.lead_id, messageId: due.message_id }, 'Falha no worker de envio; ciclo continua');
      }
    }
  } finally {
    outboundDeliveryRunning = false;
  }
}

export function startOutboundDeliveryWorker(): void {
  if (outboundDeliveryTimer) return;

  void flushDueOutboundMessages().catch((err) => {
    log.error({ err }, 'Falha no primeiro ciclo do worker de envio');
  });

  outboundDeliveryTimer = setInterval(() => {
    void flushDueOutboundMessages().catch((err) => {
      log.error({ err }, 'Falha no worker de envio');
    });
  }, OUTBOUND_DELIVERY_INTERVAL_MS);

  log.info({ intervalMs: OUTBOUND_DELIVERY_INTERVAL_MS }, 'Worker de envio agendado iniciado');
}

export function stopOutboundDeliveryWorker(): void {
  if (!outboundDeliveryTimer) return;
  clearInterval(outboundDeliveryTimer);
  outboundDeliveryTimer = null;
}

export async function personalizeLead(leadId: string): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { lead_id: leadId } });
  if (!lead) throw new Error(`Lead nao encontrado: ${leadId}`);

  const diagnosis = await prisma.companyDiagnosis.findFirst({
    where: { lead_id: leadId },
    orderBy: { created_at: 'desc' }
  });

  if (!diagnosis || diagnosis.low_confidence || !diagnosis.personalization_hook) {
    await prisma.lead.update({ where: { lead_id: leadId }, data: { research_status: 'quarantine' } });
    log.warn({ leadId }, 'Personalizacao bloqueada por diagnostico ausente/fraco');
    return;
  }

  const existingFirstContact = await prisma.outboundMessage.findFirst({
    where: {
      lead_id: leadId,
      type: 'first_contact',
      delivery_status: { in: ['scheduled', 'sent', 'failed'] }
    },
    select: { message_id: true, delivery_status: true }
  });

  if (existingFirstContact) {
    log.info(
      { leadId, messageId: existingFirstContact.message_id, status: existingFirstContact.delivery_status },
      'Primeira mensagem nao recriada porque ja existe tentativa de contato inicial'
    );
    return;
  }

  const llm = await callLLM({
    systemPrompt: MESSAGE_SYSTEM_PROMPT,
    userContent: buildMessageUserContent({
      agentName: env.DEFAULT_AGENT_NAME,
      companyName: lead.company_name,
      contactName: lead.contact_name,
      serviceCategory: env.DEFAULT_SERVICE_CATEGORY,
      hook: diagnosis.personalization_hook,
      detectedProblems: parseStringArray(diagnosis.detected_problems),
      opportunities: parseStringArray(diagnosis.opportunities)
    }),
    expectJson: true,
    maxTokens: 500,
    temperature: 0.4
  });

  const parsed = MessageResponseSchema.parse(parseJsonResponse<unknown>(llm.text));
  const sendAt = env.SEND_FIRST_MESSAGE_IMMEDIATELY ? new Date() : nextValidSendTime();

  const outbound = await prisma.outboundMessage.create({
    data: {
      lead_id: leadId,
      body: parsed.message,
      type: 'first_contact',
      scheduled_at: sendAt
    },
    select: { message_id: true }
  });

  const delay = Math.max(0, sendAt.getTime() - Date.now());
  if (delay === 0) {
    const status = await sendOutboundMessage(outbound.message_id);
    if (status === 'sent') {
      log.info({ leadId }, 'Primeira mensagem personalizada enviada');
    } else if (status === 'failed') {
      log.warn({ leadId }, 'Primeira mensagem personalizada gerada, mas nao entregue');
    } else if (status === 'deferred') {
      log.warn({ leadId }, 'Primeira mensagem personalizada gerada e mantida agendada para retry');
    }
    return;
  }

  setTimeout(() => {
    sendOutboundMessage(outbound.message_id).catch((err) => {
      log.error({ err, leadId }, 'Falha ao enviar mensagem agendada');
    });
  }, delay);
  log.info({ leadId, sendAt, delay }, 'Primeira mensagem personalizada agendada em memoria');
}
