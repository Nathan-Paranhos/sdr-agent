import { FastifyInstance } from 'fastify';
import { recordQualificationForm, renderQualificationForm } from '../../modules/qualification/qualification.service.js';

export async function qualifyRoutes(server: FastifyInstance): Promise<void> {
  server.get('/qualify/:leadId', {
    schema: {
      description: 'Página HTML do formulário de qualificação de Lead',
      tags: ['Qualificação'],
      params: {
        type: 'object',
        properties: { leadId: { type: 'string' } }
      }
    }
  }, async (req, reply) => {
    const { leadId } = req.params as { leadId: string };
    reply.type('text/html');
    return renderQualificationForm(leadId);
  });

  server.post('/qualify/:leadId', {
    schema: {
      description: 'Processa envio do formulário de qualificação',
      tags: ['Qualificação'],
      params: {
        type: 'object',
        properties: { leadId: { type: 'string' } }
      },
      response: {
        200: { description: 'Qualificação salva', type: 'object' }
      }
    }
  }, async (req) => {
    const { leadId } = req.params as { leadId: string };
    await recordQualificationForm(leadId, req.body as Record<string, unknown>);
    return { ok: true };
  });
}
