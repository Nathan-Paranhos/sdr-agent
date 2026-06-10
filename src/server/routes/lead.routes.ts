import { FastifyInstance } from 'fastify';
import { env } from '../../config/env.js';
import { prisma } from '../../db/client.js';
import { ingestCsvText, ingestLead, ingestMany } from '../../modules/ingestion/ingestion.service.js';
import { LeadBatchSchema, LeadInputSchema } from '../../modules/ingestion/ingestion.schema.js';

export async function leadRoutes(server: FastifyInstance): Promise<void> {
  server.post('/leads', {
    schema: {
      description: 'Ingestão de leads via JSON, Batch ou CSV/Texto',
      tags: ['Leads'],
      response: {
        201: { description: 'Lead(s) criado(s) com sucesso', type: 'object' }
      }
    }
  }, async (req, reply) => {
    if (typeof req.body === 'string') {
      return ingestCsvText(req.body);
    }

    const body = req.body as unknown;
    const batch = LeadBatchSchema.safeParse(body);
    if (batch.success) return { results: await ingestMany(batch.data.leads) };

    const single = LeadInputSchema.parse({
      ...(body as Record<string, unknown>),
      tenant_id: (body as Record<string, unknown>).tenant_id ?? env.DEFAULT_TENANT_ID
    });
    reply.code(201);
    return ingestLead(single);
  });

  server.get('/leads', {
    schema: {
      description: 'Lista os últimos 100 leads processados',
      tags: ['Leads'],
      response: {
        200: { description: 'Lista de leads', type: 'object' }
      }
    }
  }, async () => {
    const leads = await prisma.lead.findMany({
      orderBy: { created_at: 'desc' },
      take: 100,
      select: {
        lead_id: true,
        company_name: true,
        contact_name: true,
        phone: true,
        research_status: true,
        conversation_status: true,
        lead_score: true,
        created_at: true
      }
    });
    return { leads };
  });
}
