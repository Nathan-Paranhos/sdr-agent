import { log } from '../../config/logger.js';
import { prisma } from '../../db/client.js';
import { phoneDigits } from '../../db/utils.js';
import { enqueueResearch } from '../research/research.service.js';
import { LeadInput, LeadInputSchema } from './ingestion.schema.js';
import { parseCsvLeads } from './sources/csv.source.js';

export { LeadInputSchema };

type QuarantineResult = { valid: false; reason: 'phone_missing' | 'no_research_source' } | { valid: true };
type IngestResult = { leadId: string | null; status: string; reason?: string };
type CsvIngestSummary = { received: number; processing: number; quarantine: number; failed: number };

function validateForResearch(lead: LeadInput): QuarantineResult {
  if (!lead.phone) return { valid: false, reason: 'phone_missing' };
  if (!lead.website && !lead.instagram) return { valid: false, reason: 'no_research_source' };
  return { valid: true };
}

export async function ingestLead(input: LeadInput): Promise<{ leadId: string; status: string }> {
  const parsed = LeadInputSchema.parse(input);
  const validation = validateForResearch(parsed);
  const researchStatus = validation.valid ? 'pending' : 'quarantine';
  const digits = phoneDigits(parsed.phone);
  const resetData = validation.valid
    ? {
        research_status: researchStatus,
        conversation_status: 'not_started',
        lead_score: 0,
        follow_up_count: 0,
        last_message_at: null,
        form_sent_at: null,
        form_responses: null
      }
    : { research_status: researchStatus };

  const lead = await prisma.lead.upsert({
    where: { phone_digits_tenant_id: { phone_digits: digits, tenant_id: parsed.tenant_id } },
    update: {
      company_name: parsed.company_name,
      contact_name: parsed.contact_name ?? null,
      phone: parsed.phone,
      website: parsed.website ?? null,
      instagram: parsed.instagram ?? null,
      source: parsed.source,
      segment: parsed.segment ?? null,
      ...resetData
    },
    create: {
      company_name: parsed.company_name,
      contact_name: parsed.contact_name ?? null,
      phone: parsed.phone,
      phone_digits: digits,
      website: parsed.website ?? null,
      instagram: parsed.instagram ?? null,
      source: parsed.source,
      segment: parsed.segment ?? null,
      tenant_id: parsed.tenant_id,
      research_status: researchStatus
    },
    select: { lead_id: true }
  });

  if (validation.valid) {
    await prisma.humanQueue.updateMany({
      where: { lead_id: lead.lead_id, status: 'pending' },
      data: {
        status: 'resolved',
        assigned_to: 'system_reingest',
        resolved_at: new Date()
      }
    });

    enqueueResearch(lead.lead_id);
    log.info({ leadId: lead.lead_id, operation: 'lead_ingested', status: 'processing' });
  } else {
    log.warn({ leadId: lead.lead_id, reason: validation.reason, operation: 'lead_quarantined' });
  }

  return { leadId: lead.lead_id, status: researchStatus };
}

export async function ingestMany(inputs: LeadInput[]): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (const input of inputs) {
    try {
      results.push(await ingestLead(input));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error(
        { err, companyName: input.company_name, phone: input.phone },
        'Lead do lote nao foi importado; importacao continua'
      );
      results.push({ leadId: null, status: 'failed', reason });
    }
  }
  return results;
}

export async function ingestCsvText(csv: string): Promise<CsvIngestSummary> {
  let leads: LeadInput[];
  try {
    leads = parseCsvLeads(csv);
  } catch (err) {
    log.error({ err }, 'CSV nao pode ser parseado; processo continua aguardando novo arquivo');
    return {
      received: 0,
      processing: 0,
      quarantine: 0,
      failed: 1
    };
  }

  const results = await ingestMany(leads);
  return {
    received: results.length,
    processing: results.filter((result) => result.status === 'pending').length,
    quarantine: results.filter((result) => result.status === 'quarantine').length,
    failed: results.filter((result) => result.status === 'failed').length
  };
}
