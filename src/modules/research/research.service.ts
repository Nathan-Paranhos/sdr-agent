import { z } from 'zod';
import { log } from '../../config/logger.js';
import { prisma } from '../../db/client.js';
import { stringifyJson } from '../../db/utils.js';
import { callLLM, parseJsonResponse } from '../../integrations/groq/llm.client.js';
import { personalizeLead } from '../personalization/personalization.service.js';
import { buildDiagnosisUserContent, DIAGNOSIS_SYSTEM_PROMPT } from './diagnosis.prompt.js';
import { scrapeInstagram, InstagramData } from './instagram.js';
import { scrapeWebsiteText } from './scraper.js';

const DiagnosisSchema = z.object({
  company_segment: z.string().nullable(),
  company_size_estimate: z.enum(['micro', 'pequena', 'média', 'grande']).nullable(),
  main_service: z.string().nullable(),
  detected_problems: z.array(z.string()).default([]),
  opportunities: z.array(z.string()).default([]),
  tech_stack_detected: z.array(z.string()).default([]),
  tone: z.enum(['formal', 'informal', 'técnico']).nullable(),
  instagram_active: z.boolean().nullable(),
  website_quality: z.enum(['ruim', 'médio', 'bom']).nullable(),
  personalization_hook: z.string().nullable(),
  confidence_score: z.number().min(0).max(1),
  research_sources: z.array(z.string()).default([])
});

type Diagnosis = z.infer<typeof DiagnosisSchema>;

const RESEARCH_WORKER_INTERVAL_MS = 60_000;
const RESEARCH_WORKER_BATCH_SIZE = 5;
const activeResearchLeads = new Set<string>();

let researchWorkerTimer: NodeJS.Timeout | null = null;
let researchWorkerRunning = false;

function hasGoogleMapsSource(diagnosis: Diagnosis, websiteText: string | null): boolean {
  return Boolean(
    websiteText?.includes('Fonte: Google Maps') ||
      diagnosis.research_sources.some((source) => source.toLowerCase().includes('google maps'))
  );
}

async function quarantineLead(leadId: string, reason: string): Promise<void> {
  const lead = await prisma.lead.update({
    where: { lead_id: leadId },
    data: { research_status: 'quarantine' },
    select: { lead_id: true, tenant_id: true }
  });

  await prisma.humanQueue.create({
    data: {
      lead_id: lead.lead_id,
      tenant_id: lead.tenant_id,
      reason: 'low_confidence',
      context: stringifyJson({ reason })
    }
  });
}

async function quarantineAfterPipelineError(leadId: string, reason: string, err: unknown): Promise<void> {
  log.error({ err, leadId, reason }, 'Pipeline do lead falhou de forma controlada; lead enviado para quarentena');

  try {
    await quarantineLead(leadId, reason);
  } catch (quarantineErr) {
    log.error({ err: quarantineErr, leadId, reason }, 'Falha ao colocar lead em quarentena apos erro do pipeline');
  }
}

export function enqueueResearch(leadId: string): void {
  if (activeResearchLeads.has(leadId)) {
    log.debug({ leadId }, 'Pesquisa ignorada porque o lead ja esta em processamento');
    return;
  }

  activeResearchLeads.add(leadId);
  void runResearch(leadId)
    .catch((err) => quarantineAfterPipelineError(leadId, 'pipeline_unhandled_error', err))
    .finally(() => {
      activeResearchLeads.delete(leadId);
    });
}

export async function flushPendingResearch(limit = RESEARCH_WORKER_BATCH_SIZE): Promise<void> {
  if (researchWorkerRunning) return;
  researchWorkerRunning = true;

  try {
    const leads = await prisma.lead.findMany({
      where: { research_status: { in: ['pending', 'running'] } },
      orderBy: { updated_at: 'asc' },
      take: limit,
      select: { lead_id: true }
    });

    for (const lead of leads) {
      enqueueResearch(lead.lead_id);
    }
  } finally {
    researchWorkerRunning = false;
  }
}

export function startResearchWorker(): void {
  if (researchWorkerTimer) return;

  void flushPendingResearch().catch((err) => {
    log.error({ err }, 'Falha no primeiro ciclo do worker de pesquisa');
  });

  researchWorkerTimer = setInterval(() => {
    void flushPendingResearch().catch((err) => {
      log.error({ err }, 'Falha no worker de pesquisa');
    });
  }, RESEARCH_WORKER_INTERVAL_MS);

  log.info({ intervalMs: RESEARCH_WORKER_INTERVAL_MS }, 'Worker de pesquisa iniciado');
}

export function stopResearchWorker(): void {
  if (!researchWorkerTimer) return;
  clearInterval(researchWorkerTimer);
  researchWorkerTimer = null;
}

export async function runResearch(leadId: string): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { lead_id: leadId } });
  if (!lead) throw new Error(`Lead nao encontrado: ${leadId}`);

  await prisma.lead.update({ where: { lead_id: leadId }, data: { research_status: 'running' } });

  const websiteText = lead.website ? await scrapeWebsiteText(lead.website) : null;
  const instagramData: InstagramData | null = lead.instagram ? await scrapeInstagram(lead.instagram) : null;

  if (!websiteText && !instagramData) {
    await quarantineLead(leadId, 'research_sources_failed');
    log.warn({ leadId }, 'Lead em quarentena: pesquisa sem dados uteis');
    return;
  }

  const userContent = buildDiagnosisUserContent({
    companyName: lead.company_name,
    ...(websiteText ? { websiteText } : {}),
    ...(instagramData ? { instagramData } : {}),
    ...(lead.segment ? { segment: lead.segment } : {})
  });

  let diagnosis: Diagnosis;
  try {
    const llm = await callLLM({
      systemPrompt: DIAGNOSIS_SYSTEM_PROMPT,
      userContent,
      expectJson: true,
      maxTokens: 1200
    });
    diagnosis = DiagnosisSchema.parse(parseJsonResponse<unknown>(llm.text));
  } catch (err) {
    await quarantineLead(leadId, 'diagnosis_llm_failed');
    log.error({ err, leadId }, 'Diagnostico por LLM falhou; lead em quarentena e fila continua');
    return;
  }

  const allowMapsOnlyDiagnosis =
    hasGoogleMapsSource(diagnosis, websiteText) &&
    Boolean(diagnosis.personalization_hook) &&
    diagnosis.confidence_score >= 0.2 &&
    Boolean(lead.segment || diagnosis.company_segment);
  const lowConfidence = !diagnosis.personalization_hook || (diagnosis.confidence_score < 0.35 && !allowMapsOnlyDiagnosis);

  await prisma.companyDiagnosis.create({
    data: {
      lead_id: leadId,
      company_segment: diagnosis.company_segment,
      company_size_estimate: diagnosis.company_size_estimate,
      main_service: diagnosis.main_service,
      detected_problems: stringifyJson(diagnosis.detected_problems),
      opportunities: stringifyJson(diagnosis.opportunities),
      tech_stack_detected: stringifyJson(diagnosis.tech_stack_detected),
      tone: diagnosis.tone,
      instagram_active: diagnosis.instagram_active,
      website_quality: diagnosis.website_quality,
      personalization_hook: diagnosis.personalization_hook,
      confidence_score: diagnosis.confidence_score,
      low_confidence: lowConfidence,
      research_sources: stringifyJson(diagnosis.research_sources),
      raw_website_text: websiteText,
      raw_instagram_data: stringifyJson(instagramData)
    }
  });

  if (lowConfidence) {
    await quarantineLead(leadId, 'low_confidence_diagnosis');
    return;
  }

  await prisma.lead.update({ where: { lead_id: leadId }, data: { research_status: 'done' } });
  try {
    await personalizeLead(leadId);
  } catch (err) {
    await quarantineAfterPipelineError(leadId, 'personalization_failed', err);
    return;
  }
  log.info({ leadId, confidence: diagnosis.confidence_score }, 'Diagnostico salvo e primeira mensagem processada');
}
