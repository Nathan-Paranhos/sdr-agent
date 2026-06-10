import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { log } from '../../config/logger.js';
import { callLLM } from '../../integrations/groq/llm.client.js';

let lastReport: string = 'Nenhum relatório gerado ainda. Aguardando arquivos HTML.';

export async function processHtmlMetricsAndGenerateReport() {
  const rootDir = path.resolve(process.cwd(), '..'); // Volta para chatbot (raiz acima de sdr-agent) onde estão os HTMLs
  
  try {
    const files = await fs.readdir(rootDir);
    const htmlFiles = files.filter(f => f.endsWith('.html') && ['conversa.html', 'index.html', 'produtos.html'].includes(f));
    
    if (htmlFiles.length === 0) {
      log.info('Nenhum arquivo HTML de métricas encontrado para análise na raiz.');
      return;
    }

    let combinedText = '';

    for (const file of htmlFiles) {
      const filePath = path.join(rootDir, file);
      const content = await fs.readFile(filePath, 'utf-8');
      const $ = cheerio.load(content);
      
      // Remove scripts and styles for cleaner text
      $('script, style').remove();
      
      combinedText += `\n\n--- Conteúdo de ${file} ---\n`;
      combinedText += $('body').text().replace(/\s+/g, ' ').substring(0, 30000); // Limita tamanho para não estourar o contexto
    }

    log.info('HTMLs carregados. Solicitando análise contínua à Groq...');

    const prompt = `Você é um Analista de Negócios Sênior e Especialista em Melhoria Contínua da Aithos Tech.
Analise os dados extraídos das páginas HTML (métricas de conversas, index, produtos) e crie um Dashboard de Melhoria Contínua em formato Markdown.
Destaque:
1. Resumo Executivo das Métricas
2. Gargalos e Oportunidades
3. Plano de Ação (Continuous Improvement) para equipe técnica e vendas.

Dados extraídos:
${combinedText}
`;

    const result = await callLLM({
      systemPrompt: 'Você é um assistente analítico focado em conversão e otimização de SaaS e vendas.',
      userContent: prompt,
      temperature: 0.3,
      maxTokens: 4000
    });

    lastReport = result.text;
    log.info('Análise de métricas concluída. Relatório salvo em memória.');

    // Cleanup: Remove os arquivos originais
    for (const file of htmlFiles) {
      const filePath = path.join(rootDir, file);
      await fs.unlink(filePath);
      log.info({ file }, 'Arquivo de métricas deletado após processamento.');
    }

  } catch (err) {
    log.error({ err }, 'Erro ao processar HTMLs de métricas');
  }
}

export function getDashboardReport(): string {
  return lastReport;
}
