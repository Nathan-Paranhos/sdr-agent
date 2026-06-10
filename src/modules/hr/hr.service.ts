import { PDFParse } from 'pdf-parse';
import { env } from '../../config/env.js';
import { log } from '../../config/logger.js';
import { callLLM } from '../../integrations/groq/llm.client.js';

export interface JobListing {
  title: string;
  company_name: string;
  url: string;
  tags: string[];
}

/**
 * Fetches recent job postings matching Brazil (Campinas, Jundiai, Itupeva, and Remote).
 * Uses Adzuna if keys are configured, otherwise falls back to GitHub vagas repositories.
 */
export async function fetchBrazilianJobs(): Promise<JobListing[]> {
  const appId = env.ADZUNA_APP_ID;
  const appKey = env.ADZUNA_APP_KEY;

  if (appId?.trim() && appKey?.trim()) {
    log.info('ADZUNA: Buscando vagas brasileiras usando chaves configuradas...');
    const results: JobListing[] = [];
    const locations = ['Campinas', 'Jundiai', 'Itupeva', 'Remoto'];
    
    for (const loc of locations) {
      try {
        const query = loc === 'Remoto' ? 'what=remoto' : `where=${loc}`;
        const url = `https://api.adzuna.com/v1/api/jobs/br/search/1?app_id=${appId.trim()}&app_key=${appKey.trim()}&results_per_page=15&${query}`;
        const response = await fetch(url);
        if (response.ok) {
          const data = (await response.json()) as any;
          if (data && Array.isArray(data.results)) {
            for (const job of data.results) {
              results.push({
                title: job.title || 'Vaga Sem Título',
                company_name: job.company?.display_name || 'Empresa Confidencial',
                url: job.redirect_url || '#',
                tags: [job.location?.display_name || loc]
              });
            }
          }
        } else {
          log.warn({ status: response.status, location: loc }, 'Adzuna API returned non-OK status');
        }
      } catch (err) {
        log.error({ err, location: loc }, 'Erro ao buscar no Adzuna');
      }
    }
    
    if (results.length > 0) {
      log.info({ count: results.length }, 'Vagas recuperadas via Adzuna');
      return results;
    }
  }

  // Fallback to GitHub Vagas repositories (IT/Developer focus)
  log.info('GITHUB: Buscando vagas em repositórios br/vagas...');
  const repos = ['backend-br/vagas', 'frontendbr/vagas'];
  const results: JobListing[] = [];
  
  for (const repo of repos) {
    try {
      const url = `https://api.github.com/repos/${repo}/issues?state=open&per_page=30`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'SDR-Agent-Bot' }
      });
      if (response.ok) {
        const data = (await response.json()) as any[];
        if (Array.isArray(data)) {
          for (const issue of data) {
            const titleLower = (issue.title || '').toLowerCase();
            const bodyLower = (issue.body || '').toLowerCase();
            const isMatch = ['campinas', 'jundiai', 'itupeva', 'remoto', 'remote'].some(
              (term) => titleLower.includes(term) || bodyLower.includes(term)
            );
            
            if (isMatch) {
              results.push({
                title: issue.title || 'Oportunidade',
                company_name: 'GitHub Vagas',
                url: issue.html_url || '#',
                tags: [repo.split('/')[0] || repo]
              });
            }
          }
        }
      } else {
        log.warn({ status: response.status, repo }, 'GitHub API returned non-OK status');
      }
    } catch (err) {
      log.error({ err, repo }, 'Erro ao buscar no GitHub vagas');
    }
  }
  
  log.info({ count: results.length }, 'Vagas recuperadas via GitHub');
  return results;
}

/**
 * Extracts raw text from a PDF buffer.
 */
export async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  let parser: any = null;
  try {
    log.info({ bufferSize: buffer.length }, 'Extraindo texto do PDF...');
    parser = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await parser.getText();
    const text = result.text || '';
    log.info({ textLength: text.length }, 'Texto do PDF extraído com sucesso');
    return text.trim();
  } catch (err) {
    log.error({ err }, 'Erro ao extrair texto do PDF');
    throw new Error('Não foi possível ler o arquivo PDF. Certifique-se de que ele não está corrompido ou protegido por senha.');
  } finally {
    if (parser) {
      try {
        await parser.destroy();
      } catch (destroyErr) {
        log.warn({ destroyErr }, 'Erro ao destruir o parser de PDF');
      }
    }
  }
}

/**
 * Orchestrates the full CV analysis and job matching pipeline.
 */
export async function analyzeCvAndMatchJobs(pdfBuffer: Buffer): Promise<string> {
  const [cvText, jobs] = await Promise.all([
    extractTextFromPdf(pdfBuffer),
    fetchBrazilianJobs()
  ]);

  if (!cvText) {
    return '⚠️ *Erro na leitura do arquivo:* Não conseguimos extrair nenhum texto do PDF do seu currículo. Certifique-se de que o arquivo contém texto legível (e não seja apenas uma imagem escaneada).';
  }

  const prunedJobs = jobs.slice(0, 60).map((job) => ({
    title: job.title,
    company: job.company_name,
    tags: job.tags,
    url: job.url
  }));

  log.info('Iniciando análise com LLM Groq...');

  const systemPrompt = `Atue como um especialista sênior em recrutamento, headhunter executivo, consultor de RH, especialista em ATS (Applicant Tracking Systems), analista de LinkedIn e consultor de carreira extremamente crítico.

Sua missão é realizar uma auditoria completa, detalhada e extremamente crítica do currículo fornecido. Não faça uma análise superficial. Analise cada seção, cada informação, cada palavra e cada elemento do currículo. Considere que o objetivo é maximizar as chances de contratação e destacar pontos fortes e fracos em relação ao mercado atual.

Formatação Obrigatória para WhatsApp:
1. NÃO use cabeçalhos Markdown normais (como #, ##, ###). Use APENAS *negrito* com asteriscos para títulos.
2. Use a linha separadora ━━━━━━━━━━━━━━━━━━ entre cada uma das etapas.
3. Use tópicos organizados com emojis adequados e espaçamento limpo.
4. Toda a resposta deve ser escrita em Português do Brasil de forma extremamente clara, profissional e direta.

Abaixo estão as etapas obrigatórias que você deve seguir estritamente na sua resposta:

━━━━━━━━━━━━━━━━━━
*ETAPA 1 - LEITURA E MAPEAMENTO*
Extraia e organize:
- Nome
- Cargo atual
- Objetivo profissional
- Área de atuação
- Experiência profissional
- Formação acadêmica
- Certificações
- Cursos
- Idiomas
- Competências técnicas
- Competências comportamentais
- Projetos
- Portfólio
- Redes profissionais
- Contatos
Monte um resumo estruturado do currículo.

━━━━━━━━━━━━━━━━━━
*ETAPA 2 - ANÁLISE ESTRUTURAL*
Avalie:
- Organização visual
- Clareza
- Hierarquia das informações
- Escaneabilidade
- Legibilidade
- Uso de títulos
- Uso de subtítulos
- Consistência de formatação
- Tamanho do currículo
- Distribuição das informações
- Excesso de texto
- Falta de informações
Classifique cada item de 0 a 10. Explique detalhadamente cada nota.

━━━━━━━━━━━━━━━━━━
*ETAPA 3 - ANÁLISE DE ATS*
Verifique:
- Compatibilidade com ATS
- Uso correto de palavras-chave
- Estrutura ATS Friendly
- Problemas de leitura automatizada
- Palavras-chave ausentes
- Tecnologias relevantes não mencionadas
- Falta de termos buscados por recrutadores
Forneça:
- Score ATS
- Principais falhas
- Recomendações de otimização

━━━━━━━━━━━━━━━━━━
*ETAPA 4 - EXPERIÊNCIA PROFISSIONAL*
Analise cada experiência individualmente.
Para cada experiência:
- Avaliar: Clareza, Impacto, Relevância, Resultados apresentados, Métricas utilizadas, Tecnologias mencionadas, Tempo de permanência, Evolução profissional.
- Identificar: Informações vagas, Informações redundantes, Experiências mal descritas, Falta de resultados mensuráveis, Falta de contexto.
- Melhorar: Reescreva cada experiência de forma profissional.

━━━━━━━━━━━━━━━━━━
*ETAPA 5 - COMPETÊNCIAS TÉCNICAS*
Mapeie todas as competências.
Classifique as competências encontradas nos níveis:
- Básico
- Intermediário
- Avançado
- Especialista
Identifique:
- Competências faltantes
- Tecnologias desatualizadas
- Habilidades irrelevantes
- Competências valorizadas pelo mercado
Monte uma matriz de competências.

━━━━━━━━━━━━━━━━━━
*ETAPA 6 - ANÁLISE DE MERCADO*
Pesquise o mercado atual da área do candidato.
Compare o currículo com:
- Vagas atuais
- Exigências do mercado
- Concorrentes profissionais
- Tendências da área
- Tecnologias mais buscadas
Identifique:
- Lacunas
- Vantagens competitivas
- Desvantagens competitivas
Além disso, com base na lista de vagas reais fornecida no final deste prompt:
1. Recomende até 5 vagas compatíveis, priorizando as localizadas em Campinas, Itupeva, Jundiaí ou que sejam 100% Remotas.
2. Para cada vaga recomendada, informe:
   - 📌 *[Título da Vaga]* - [Empresa/Origem]
   - 💡 *Por que combina com você*: Explicação curta e analítica da compatibilidade baseada na experiência real do candidato.
   - 🔗 *Link para inscrição*: [URL da vaga]
(Se nenhuma vaga da lista for compatível, explique essa limitação de forma clara e crítica, mas forneça sugestões de links de busca direta no LinkedIn e Indeed filtrados para a profissão e regiões desejadas: Campinas, Jundiaí, Itupeva ou Remoto).

━━━━━━━━━━━━━━━━━━
*ETAPA 7 - BENCHMARK*
Compare o currículo com:
- Profissionais juniores
- Profissionais plenos
- Profissionais seniores
- Profissionais especialistas
- Profissionais referência da área
Determine o nível real do candidato. Justifique a conclusão.

━━━━━━━━━━━━━━━━━━
*ETAPA 8 - ANÁLISE DE POSICIONAMENTO*
Avalie:
- Marca pessoal
- Autoridade
- Diferenciação
- Proposta de valor
- Especialização
- Posicionamento profissional
Identifique:
- Pontos genéricos
- Oportunidades de destaque
- Diferenciais pouco explorados

━━━━━━━━━━━━━━━━━━
*ETAPA 9 - LINKEDIN*
Analise a compatibilidade do currículo com LinkedIn.
Identifique:
- Informações ausentes
- Informações redundantes
- Melhorias recomendadas
- Estratégias de visibilidade
Crie sugestões para:
- Headline
- Sobre
- Experiências
- Competências

━━━━━━━━━━━━━━━━━━
*ETAPA 10 - ANÁLISE DE RECRUTADOR*
Assuma o papel de:
- RH
- Tech Recruiter
- Gestor da área
- Diretor
- CEO
Informe para cada papel acima:
- Primeira impressão
- Riscos percebidos
- Pontos fortes
- Motivos para entrevista
- Motivos para rejeição

━━━━━━━━━━━━━━━━━━
*ETAPA 11 - RED FLAGS*
Identifique:
- Lacunas profissionais
- Job hopping
- Inconsistências
- Exageros
- Possíveis mentiras
- Informações confusas
- Falta de comprovação
Classifique o nível de risco (Baixo, Médio ou Alto) e justifique a conclusão.

━━━━━━━━━━━━━━━━━━
*ETAPA 12 - REESCRITA COMPLETA*
Reescreva o currículo inteiro.
Objetivos:
- Máxima aprovação ATS
- Máxima atratividade para recrutadores
- Linguagem profissional
- Clareza
- Persuasão
- Resultados mensuráveis
Entregue a versão final pronta para uso.

━━━━━━━━━━━━━━━━━━
*ETAPA 13 - PLANO DE EVOLUÇÃO*
Monte um roadmap profissional contendo:
- Curto prazo (30 dias)
  - Melhorias imediatas
  - Cursos recomendados
  - Certificações prioritárias
- Médio prazo (6 meses)
  - Competências a desenvolver
  - Projetos para portfólio
- Longo prazo (12 a 24 meses)
  - Evolução de carreira
  - Especializações
  - Posicionamento de mercado

━━━━━━━━━━━━━━━━━━
*ETAPA 14 - RELATÓRIO EXECUTIVO FINAL*
Gerar:
- Nota Geral (0 a 100)
- Score ATS (0 a 100)
- Score Mercado (0 a 100)
- Score Competitividade (0 a 100)
- Score LinkedIn (0 a 100)
- Score Contratabilidade (0 a 100)

SWOT:
- Forças
- Fraquezas
- Oportunidades
- Ameaças

Conclusão Final:
Explique:
- Qual o nível do candidato
- Quais vagas ele consegue disputar hoje
- Qual faixa salarial é compatível
- O que precisa melhorar para alcançar o próximo nível`;

  const userContent = `Aqui está o currículo extraído:
---
${cvText}
---

Aqui está a lista de vagas de emprego disponíveis:
${JSON.stringify(prunedJobs, null, 2)}`;

  try {
    const llmResult = await callLLM({
      systemPrompt,
      userContent,
      temperature: 0.3,
      maxTokens: 4000
    });

    log.info('Análise de currículo finalizada com sucesso');
    return llmResult.text;
  } catch (err) {
    log.error({ err }, 'Erro ao chamar LLM para análise do currículo');
    return '⚠️ *Desculpe!* Ocorreu um erro ao processar a análise do seu currículo com nossa Inteligência Artificial. Por favor, tente novamente em instantes.';
  }
}
