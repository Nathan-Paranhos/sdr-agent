import { FastifyInstance } from 'fastify';
import { getDashboardReport, processHtmlMetricsAndGenerateReport } from '../../modules/metrics-dashboard/metrics.service.js';
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt();

export async function metricsRoutes(server: FastifyInstance): Promise<void> {
  server.get('/dashboard', {
    schema: {
      description: 'Retorna o dashboard de métricas e melhoria contínua',
      tags: ['Dashboard', 'Métricas'],
      response: {
        200: {
          type: 'string',
          description: 'Dashboard renderizado em HTML a partir do Markdown do relatório'
        }
      }
    }
  }, async (_req, reply) => {
    const reportMarkdown = getDashboardReport();
    const htmlBody = md.render(reportMarkdown);
    
    const html = `
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <title>Dashboard Aithos - Melhoria Contínua</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem; line-height: 1.6; }
          .container { max-width: 900px; margin: 0 auto; background: #1e293b; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
          h1, h2, h3 { color: #38bdf8; }
          ul, ol { margin-left: 1.5rem; }
          a { color: #2dd4bf; }
          pre { background: #0b0f19; padding: 1rem; border-radius: 4px; overflow-x: auto; }
        </style>
      </head>
      <body>
        <div class="container">
          ${htmlBody}
        </div>
      </body>
      </html>
    `;
    
    reply.type('text/html').send(html);
  });

  server.post('/dashboard/trigger', {
    schema: {
      description: 'Força o processamento imediato dos arquivos HTML de métricas na raiz',
      tags: ['Dashboard', 'Métricas'],
      response: {
        200: {
          type: 'object',
          properties: { success: { type: 'boolean' }, message: { type: 'string' } }
        }
      }
    }
  }, async () => {
    processHtmlMetricsAndGenerateReport().catch(console.error); // Executa em background
    return { success: true, message: 'Processamento autônomo iniciado em background' };
  });
}
