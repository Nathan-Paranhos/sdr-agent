import { prisma } from '../../db/client.js';
import { stringifyJson } from '../../db/utils.js';

export type HumanQueueReason = 'low_confidence' | 'hostile' | 'requested' | 'manual' | 'opportunity';

function statusForQueueReason(reason: HumanQueueReason): string {
  return reason === 'opportunity' ? 'qualified' : 'human_takeover';
}

export async function createHumanQueueItem(
  leadId: string,
  tenantId: string,
  reason: HumanQueueReason,
  context: Record<string, unknown>
): Promise<void> {
  const existing = await prisma.humanQueue.findFirst({
    where: {
      lead_id: leadId,
      tenant_id: tenantId,
      reason,
      status: 'pending'
    },
    select: { queue_id: true }
  });

  if (!existing) {
    await prisma.humanQueue.create({
      data: {
        lead_id: leadId,
        tenant_id: tenantId,
        reason,
        context: stringifyJson(context)
      }
    });
  }

  await prisma.lead.update({
    where: { lead_id: leadId },
    data: { conversation_status: statusForQueueReason(reason) }
  });
}

export async function listPendingHumanQueue(): Promise<unknown[]> {
  const rows = await prisma.humanQueue.findMany({
    where: { status: 'pending' },
    orderBy: { created_at: 'asc' },
    include: {
      lead: {
        select: {
          company_name: true,
          contact_name: true,
          phone: true,
          lead_score: true
        }
      }
    }
  });

  return rows.map((row) => ({
    ...row,
    company_name: row.lead.company_name,
    contact_name: row.lead.contact_name,
    phone: row.lead.phone,
    lead_score: row.lead.lead_score,
    lead: undefined
  }));
}

export async function resolveHumanQueue(queueId: string, assignedTo: string): Promise<void> {
  await prisma.humanQueue.update({
    where: { queue_id: queueId },
    data: {
      status: 'resolved',
      assigned_to: assignedTo,
      resolved_at: new Date()
    }
  });
}
