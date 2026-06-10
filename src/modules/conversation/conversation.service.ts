import { z } from 'zod';
import { env } from '../../config/env.js';
import { log } from '../../config/logger.js';
import { prisma } from '../../db/client.js';
import { parseStringArray, phoneDigits } from '../../db/utils.js';
import { callLLM, parseJsonResponse } from '../../integrations/groq/llm.client.js';
import { sendWhatsAppText } from '../../integrations/whatsapp/qr.client.js';
import { createHumanQueueItem } from '../human-queue/human-queue.service.js';
import { maybeDeliverQualifiedLead } from '../delivery/delivery.service.js';
import { buildConversationSystemPrompt } from './conversation.prompt.js';
import { buildLeadHandoffReply, buildOperatorHandoffNotification, shouldHandoffToHuman } from './handoff.js';
import { addScoreEvent, ScoreEventType } from './score.calculator.js';
import { runRemoteSecurityAudit, isAuthorizedForSec } from '../security-auditor/security-auditor.service.js';
const ConversationResponseSchema = z.object({
  reply: z.string().min(1),
  intent: z.enum(['INTEREST', 'TECH_QUESTION', 'OBJECTION', 'DISINTEREST', 'OPPORTUNITY', 'AMBIGUOUS', 'HOSTILE']),
  confidence: z.number().min(0).max(1)
});

const AUTO_PAUSED_STATUSES = new Set(['human_takeover', 'qualified', 'closed']);

export interface InboundMessage {
  phone: string;
  body: string;
  whatsappId: string | null;
  pushName: string | null;
}

function scoreEventForIntent(intent: z.infer<typeof ConversationResponseSchema>['intent']): ScoreEventType | null {
  if (intent === 'INTEREST') return 'INTENT_INTEREST';
  if (intent === 'TECH_QUESTION') return 'INTENT_TECH_QUESTION';
  if (intent === 'OPPORTUNITY') return 'INTENT_OPPORTUNITY';
  if (intent === 'DISINTEREST') return 'INTENT_DISINTEREST';
  return null;
}

function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function shouldEscalateHostile(body: string, confidence: number): boolean {
  if (confidence < 0.85) return false;

  const text = normalizeText(body);
  const escalationSignals = [
    'vou processar',
    'processar voces',
    'processar voce',
    'meu advogado',
    'advogado vai',
    'vou denunciar',
    'denunciar voces',
    'denunciar voce',
    'procon',
    'ameaca',
    'ameacar',
    'golpe',
    'fraude',
    'criminoso',
    'nunca mais me chame',
    'pare de me mandar mensagem',
    'nao me mande mensagem'
  ];

  return escalationSignals.some((signal) => text.includes(signal));
}

async function notifyOperatorOfHandoff(input: {
  lead: {
    company_name: string;
    contact_name: string | null;
    phone: string;
    lead_score: number;
  };
  segment: string | null;
  reason: string;
  lastInbound: string;
  historyRows: Array<{ role: string; body: string }>;
}): Promise<void> {
  const text = buildOperatorHandoffNotification({
    lead: {
      companyName: input.lead.company_name,
      contactName: input.lead.contact_name,
      phone: input.lead.phone,
      leadScore: input.lead.lead_score,
      segment: input.segment
    },
    reason: input.reason,
    lastInbound: input.lastInbound,
    history: input.historyRows
  });

  try {
    await sendWhatsAppText(env.OPERATOR_PHONE, text);
  } catch (err) {
    log.error({ err, operatorPhone: env.OPERATOR_PHONE }, 'Falha ao notificar operador sobre handoff');
  }
}

export async function handleInboundMessage(input: InboundMessage): Promise<void> {
  let lead = await prisma.lead.findFirst({
    where: { phone_digits: phoneDigits(input.phone) },
    orderBy: { updated_at: 'desc' }
  });

  if (!lead) {
    log.warn({ phone: input.phone }, 'Mensagem recebida sem lead cadastrado. Auto-cadastrando com DEFAULT_TENANT_ID.');
    try {
      lead = await prisma.lead.create({
        data: {
          tenant_id: env.DEFAULT_TENANT_ID,
          phone: input.phone,
          phone_digits: phoneDigits(input.phone),
          company_name: 'Usuário WhatsApp',
          source: 'inbound_whatsapp',
          conversation_status: 'not_started'
        }
      });
    } catch (err) {
      log.error({ err, phone: input.phone }, 'Falha ao criar lead automaticamente. Mensagem ignorada.');
      return;
    }
  }

  const trimmedMessage = input.body.trim();
  // --- HANDLER !sec (privado) ---
  const secMatch = trimmedMessage.match(/^!sec\s+(https?:\/\/\S+)/i);
  if (secMatch && secMatch[1]) {
    const targetUrl = secMatch[1].trim();
    const senderJid = lead.phone; // JID do lead no chat privado

    if (!isAuthorizedForSec(senderJid)) {
      await sendWhatsAppText(lead.phone, '🚫 Você não tem permissão para usar o comando !sec.');
      return;
    }

    await sendWhatsAppText(
      lead.phone,
      `🔍 *Iniciando auditoria de segurança para:*\n${targetUrl}\n\n_Você receberá atualizações de progresso._`
    );

    try {
      const report = await runRemoteSecurityAudit(
        targetUrl,
        senderJid,
        async (progressMsg) => {
          await sendWhatsAppText(lead.phone, progressMsg);
        }
      );
      await sendWhatsAppText(lead.phone, report);
    } catch (err) {
      log.error({ err, phone: lead.phone, targetUrl }, 'Erro inesperado no handler !sec (privado)');
      await sendWhatsAppText(lead.phone, '❌ Ocorreu um erro inesperado durante a auditoria. Tente novamente.');
    }

    return;
  }
  // --- FIM HANDLER !sec (privado) ---

  await prisma.message.create({
    data: {
      lead_id: lead.lead_id,
      role: 'lead',
      body: input.body,
      whatsapp_id: input.whatsappId
    }
  });

  let conversationStatus = lead.conversation_status;
  const pendingHumanQueue = await prisma.humanQueue.findFirst({
    where: { lead_id: lead.lead_id, status: 'pending' },
    select: { queue_id: true, reason: true }
  });

  if (AUTO_PAUSED_STATUSES.has(conversationStatus) || pendingHumanQueue) {
    if (pendingHumanQueue && !AUTO_PAUSED_STATUSES.has(conversationStatus)) {
      await prisma.lead.update({
        where: { lead_id: lead.lead_id },
        data: { conversation_status: pendingHumanQueue.reason === 'opportunity' ? 'qualified' : 'human_takeover' }
      });
      conversationStatus = pendingHumanQueue.reason === 'opportunity' ? 'qualified' : 'human_takeover';
    }

    log.info(
      { leadId: lead.lead_id, status: conversationStatus, queueReason: pendingHumanQueue?.reason },
      'Mensagem registrada sem resposta automatica por status de atendimento humano'
    );
    return;
  }

  if (conversationStatus === 'not_started') {
    await addScoreEvent(lead.lead_id, 'FIRST_REPLY');
  }

  if (lead.last_message_at && Date.now() - lead.last_message_at.getTime() < 60 * 60 * 1000) {
    await addScoreEvent(lead.lead_id, 'REPLY_UNDER_1H');
  }

  const tenant = await prisma.tenant.findUnique({ where: { tenant_id: lead.tenant_id } });
  const diagnosis = await prisma.companyDiagnosis.findFirst({
    where: { lead_id: lead.lead_id },
    orderBy: { created_at: 'desc' }
  });

  if (!tenant || !diagnosis || diagnosis.low_confidence) {
    await createHumanQueueItem(lead.lead_id, lead.tenant_id, 'low_confidence', { inbound: input.body });
    return;
  }

  const historyRows = (
    await prisma.message.findMany({
      where: { lead_id: lead.lead_id },
      orderBy: { created_at: 'desc' },
      take: 8,
      select: { role: true, body: true }
    })
  ).reverse();

  if (shouldHandoffToHuman(input.body, historyRows)) {
    const reply = buildLeadHandoffReply();

    await prisma.message.create({
      data: {
        lead_id: lead.lead_id,
        role: 'agent',
        body: reply,
        intent: 'OPPORTUNITY',
        confidence: 1,
        flagged: false
      }
    });

    try {
      await sendWhatsAppText(lead.phone, reply);
    } catch (err) {
      log.warn({ err, leadId: lead.lead_id }, 'Resposta de handoff nao foi entregue; conversa continua em atendimento humano');
    }
    const leadScore = await addScoreEvent(lead.lead_id, 'INTENT_OPPORTUNITY', {
      confidence: 1,
      source: 'handoff_detection'
    });

    await createHumanQueueItem(lead.lead_id, lead.tenant_id, 'requested', {
      inbound: input.body,
      trigger: 'meeting_or_proposal_request'
    });

    await prisma.lead.update({
      where: { lead_id: lead.lead_id },
      data: {
        lead_score: leadScore,
        last_message_at: new Date()
      }
    });

    await notifyOperatorOfHandoff({
      lead: { ...lead, lead_score: leadScore },
      segment: diagnosis.company_segment,
      reason: 'lead pediu reuniao/proposta',
      lastInbound: input.body,
      historyRows
    });

    return;
  }

  try {
    const llm = await callLLM({
      systemPrompt: buildConversationSystemPrompt({
        agentName: tenant.agent_name,
        companyName: 'Aithos Tech',
        serviceCategory: tenant.service_category ?? env.DEFAULT_SERVICE_CATEGORY,
        companySegment: diagnosis.company_segment,
        detectedProblems: parseStringArray(diagnosis.detected_problems),
        opportunities: parseStringArray(diagnosis.opportunities),
        tone: diagnosis.tone
      }),
      userContent: input.body,
      conversationHistory: historyRows.map((row) => ({
        role: row.role === 'agent' ? 'assistant' : 'user',
        content: row.body
      })),
      expectJson: true,
      maxTokens: 600
    });

    const parsed = ConversationResponseSchema.parse(parseJsonResponse<unknown>(llm.text));
    const escalateHostile = parsed.intent === 'HOSTILE' && shouldEscalateHostile(input.body, parsed.confidence);
    const flagged = parsed.intent === 'HOSTILE' || parsed.confidence < 0.45;

    await prisma.message.create({
      data: {
        lead_id: lead.lead_id,
        role: 'agent',
        body: parsed.reply,
        intent: parsed.intent,
        confidence: parsed.confidence,
        flagged
      }
    });

    await sendWhatsAppText(lead.phone, parsed.reply);

    const event = scoreEventForIntent(parsed.intent);
    if (event) await addScoreEvent(lead.lead_id, event, { confidence: parsed.confidence });

    if (escalateHostile) {
      await createHumanQueueItem(lead.lead_id, lead.tenant_id, 'hostile', { inbound: input.body });
    }

    await prisma.lead.update({
      where: { lead_id: lead.lead_id },
      data: {
        conversation_status:
          parsed.intent === 'DISINTEREST'
            ? 'closed'
            : escalateHostile
              ? 'human_takeover'
              : conversationStatus === 'qualified'
                ? 'qualified'
                : 'active',
        last_message_at: new Date()
      }
    });

    await maybeDeliverQualifiedLead(lead.lead_id);
  } catch (err) {
    log.error({ err, leadId: lead.lead_id }, 'Falha na resposta automatica; lead enviado para atendimento humano');
    await createHumanQueueItem(lead.lead_id, lead.tenant_id, 'manual', {
      reason: 'automation_failure',
      inbound: input.body
    });

    await notifyOperatorOfHandoff({
      lead,
      segment: diagnosis.company_segment,
      reason: 'falha da automacao',
      lastInbound: input.body,
      historyRows
    });
  }
}
