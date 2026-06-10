import { env } from '../../../config/env.js';
import { ingestLead } from '../ingestion.service.js';
import { LeadInputSchema } from '../ingestion.schema.js';

export async function ingestWebhookLead(payload: unknown): Promise<{ leadId: string; status: string }> {
  const parsed = LeadInputSchema.parse({
    ...(payload as Record<string, unknown>),
    source: 'webhook',
    tenant_id: (payload as Record<string, unknown>).tenant_id ?? env.DEFAULT_TENANT_ID
  });

  return ingestLead(parsed);
}
