import cors from '@fastify/cors';
import Fastify, { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { log } from '../config/logger.js';
import { leadRoutes } from './routes/lead.routes.js';
import { operatorRoutes } from './routes/operator.routes.js';
import { qualifyRoutes } from './routes/qualify.routes.js';
import { metricsRoutes } from './routes/metrics.routes.js';

export async function startServer(): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  await server.register(cors, { origin: true });

  await server.register(swagger, {
    openapi: {
      openapi: '3.0.0',
      info: {
        title: 'SDR Agent API',
        description: 'Documentação da API do SDR Agent (Genisis). O Genisis gerencia WhatsApp, campanhas, e realiza análise contínua de métricas.',
        version: '1.0.0'
      },
      servers: [
        { url: 'http://localhost:3001', description: 'Servidor Local (API e Dashboard)' }
      ]
    }
  });

  await server.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'full',
      deepLinking: false
    }
  });

  server.addContentTypeParser(['text/csv', 'application/csv'], { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  server.get('/health', async () => ({ ok: true }));
  await server.register(leadRoutes);
  await server.register(qualifyRoutes);
  await server.register(operatorRoutes);
  await server.register(metricsRoutes);

  server.setErrorHandler((err, _req, reply) => {
    log.error({ err }, 'Erro HTTP');
    reply.status(500).send({ error: err.message });
  });

  return server;
}
