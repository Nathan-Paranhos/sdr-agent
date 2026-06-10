import { env } from '../../config/env.js';
import { log } from '../../config/logger.js';
import { prisma } from '../../db/client.js';
import { createHumanQueueItem } from '../human-queue/human-queue.service.js';

const DELIVERY_DONE_STATUSES = new Set(['qualified', 'human_takeover', 'closed']);

export async function maybeDeliverQualifiedLead(leadId: string): Promise<void> {
  const lead = await prisma.lead.findUnique({
    where: { lead_id: leadId },
    include: {
      tenant: true,
      human_queue: {
        where: { reason: 'opportunity' },
        select: { queue_id: true },
        take: 1
      }
    }
  });

  if (!lead || lead.lead_score < lead.tenant.score_threshold) return;
  if (DELIVERY_DONE_STATUSES.has(lead.conversation_status)) return;
  if (lead.human_queue.length > 0) return;

  await createHumanQueueItem(leadId, lead.tenant_id, 'opportunity', { score: lead.lead_score });

  const text = `Lead qualificado: ${lead.company_name} (${lead.phone}) score ${lead.lead_score}. Operador: ${env.OPERATOR_PHONE}`;
  log.info({ leadId, score: lead.lead_score, operatorPhone: env.OPERATOR_PHONE, text }, 'Lead qualificado entregue ao operador');
}
