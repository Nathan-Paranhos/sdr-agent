import { FastifyInstance } from 'fastify';
import { listPendingHumanQueue, resolveHumanQueue } from '../../modules/human-queue/human-queue.service.js';

export async function operatorRoutes(server: FastifyInstance): Promise<void> {
  server.get('/operator/api/queue', {
    schema: {
      description: 'Lista a fila de atendimento humano pendente',
      tags: ['Operador Humano'],
      response: {
        200: { description: 'Fila de usuários aguardando', type: 'object' }
      }
    }
  }, async () => ({ queue: await listPendingHumanQueue() }));

  server.post('/operator/api/queue/:queueId/resolve', {
    schema: {
      description: 'Resolve/Finaliza o atendimento humano',
      tags: ['Operador Humano'],
      params: {
        type: 'object',
        properties: { queueId: { type: 'string' } }
      },
      response: {
        200: { description: 'Atendimento resolvido', type: 'object' }
      }
    }
  }, async (req) => {
    const { queueId } = req.params as { queueId: string };
    const body = req.body as { assigned_to?: string };
    await resolveHumanQueue(queueId, body?.assigned_to ?? 'operator');
    return { ok: true };
  });

  server.get('/operator', {
    schema: {
      description: 'Visualização HTML da fila do operador',
      tags: ['Operador Humano']
    }
  }, async (_req, reply) => {
    const queue = await listPendingHumanQueue();
    reply.type('text/html');
    return `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>SDR Operator</title></head>
<body>
  <h1>Fila humana</h1>
  <pre>${escapeHtml(JSON.stringify(queue, null, 2))}</pre>
</body>
</html>`;
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
