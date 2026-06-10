import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { log } from '../../config/logger.js';
import { callOpenRouterChat } from '../../integrations/openrouter/llm.client.js';

const execFileAsync = promisify(execFile);

// JIDs/números autorizados a usar !sec (separados por vírgula na env)
// Exemplo: SECURITY_AUDIT_ALLOWED_JIDS=5511999999999@s.whatsapp.net,5511888888888@s.whatsapp.net
const ALLOWED_JIDS = new Set(
  (process.env.SECURITY_AUDIT_ALLOWED_JIDS ?? '').split(',').map(s => s.trim()).filter(Boolean)
);

// Throttle: previne scans simultâneos do mesmo usuário
const activeScans = new Set<string>();

// Paths das ferramentas (configuráveis via env para Docker/VPS)
const NUCLEI_BIN   = process.env.NUCLEI_PATH   ?? 'nuclei';
const KATANA_BIN   = process.env.KATANA_PATH    ?? 'katana';
const GOSPIDER_BIN = process.env.GOSPIDER_PATH  ?? 'gospider';
const TRUFFLEHOG_BIN = process.env.TRUFFLEHOG_PATH ?? 'trufflehog';
const WGET_BIN       = process.env.WGET_PATH       ?? 'wget';

// Modo mock para desenvolvimento sem as ferramentas instaladas
const MOCK_TOOLS = process.env.SEC_MOCK_TOOLS === 'true';

// Timeout por ferramenta (ms)
const TOOL_TIMEOUT = parseInt(process.env.SEC_TOOL_TIMEOUT_MS ?? '90000', 10);

export function isAuthorizedForSec(jid: string): boolean {
  if (ALLOWED_JIDS.size === 0) return false; // nenhum autorizado se env vazia
  return ALLOWED_JIDS.has(jid);
}

async function validateUrlForScan(targetUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new Error('URL inválida. Verifique o formato: https://exemplo.com');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Apenas protocolos HTTP e HTTPS são suportados.');
  }

  if (!parsed.hostname || parsed.hostname.length < 3) {
    throw new Error('Hostname inválido na URL fornecida.');
  }

  // Bloqueia IPs literais na URL
  const ipv4Literal = /^(\d{1,3}\.){3}\d{1,3}$/.test(parsed.hostname);
  if (ipv4Literal) {
    throw new Error('IPs literais não são permitidos. Forneça um domínio público.');
  }

  // Resolve DNS e valida o IP resultante
  let resolvedIp: string;
  try {
    const lookup = await dns.lookup(parsed.hostname);
    resolvedIp = lookup.address;
  } catch {
    throw new Error(`Não foi possível resolver o DNS para "${parsed.hostname}". Verifique se o domínio existe.`);
  }

  const isLoopback  = resolvedIp === '127.0.0.1' || resolvedIp === '::1' || resolvedIp === '0.0.0.0';
  const isPrivate   =
    resolvedIp.startsWith('10.')       ||
    resolvedIp.startsWith('192.168.')  ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(resolvedIp) ||
    resolvedIp.startsWith('169.254.')  ||
    resolvedIp.startsWith('100.64.')   || // CGNAT
    resolvedIp === '::1'               ||
    resolvedIp.startsWith('fc')        ||
    resolvedIp.startsWith('fd');         // IPv6 ULA

  if (isLoopback || isPrivate) {
    throw new Error('Alvo inválido: varreduras em redes internas ou locais não são permitidas.');
  }
}

interface ToolResult {
  output: string;
  error: string | null;
  timedOut: boolean;
}

async function runTool(bin: string, args: string[], label: string): Promise<ToolResult> {
  if (MOCK_TOOLS) {
    return {
      output: getMockOutput(label),
      error: null,
      timedOut: false,
    };
  }

  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: TOOL_TIMEOUT,
      maxBuffer: 5 * 1024 * 1024, // 5MB max output
    });
    return { output: stdout.trim(), error: stderr.trim() || null, timedOut: false };
  } catch (err: any) {
    if (err.killed || err.signal === 'SIGTERM') {
      log.warn({ bin, label }, 'Ferramenta encerrada por timeout');
      return { output: err.stdout?.trim() ?? '', error: `Timeout após ${TOOL_TIMEOUT}ms`, timedOut: true };
    }
    log.error({ err, bin, label }, 'Erro na execução da ferramenta');
    return { output: err.stdout?.trim() ?? '', error: err.message, timedOut: false };
  }
}

// Crawling de endpoints e rotas (profundidade 3, JS incluso, APIs, Hidden)
async function runKatana(targetUrl: string): Promise<string> {
  const result = await runTool(KATANA_BIN, [
    '-u', targetUrl,
    '-d', '3',
    '-jc',          // executa JS para extrair rotas dinâmicas
    '-kf', 'all',   // arquivos conhecidos (env, config, wsdl, etc)
    '-xhr',         // extrai chamadas XHR
    '-f', 'qurl',   // formata output de query urls
    '-silent',
    '-timeout', '40',
    '-c', '10',     // 10 workers paralelos
  ], 'katana');
  return result.output || '[Katana: nenhum endpoint encontrado]';
}

// Crawl alternativo com gospider (descobre robots.txt, sitemaps, links externos, wayback)
async function runGospider(targetUrl: string): Promise<string> {
  const result = await runTool(GOSPIDER_BIN, [
    '-s', targetUrl,
    '-d', '3',
    '--js',          // inclui arquivos JS
    '--robots',      // lê robots.txt
    '--sitemap',     // lê sitemap.xml
    '-a',            // lê wayback machine/outras fontes
    '-q',            // quiet
    '-t', '10',       // 10 threads
  ], 'gospider');
  return result.output || '[Gospider: nenhum link encontrado]';
}

// Scan de vulnerabilidades por templates CVE/misconfig e Automatic Scan
async function runNuclei(targetUrl: string): Promise<string> {
  const result = await runTool(NUCLEI_BIN, [
    '-u', targetUrl,
    '-silent',
    '-rl', '10',     // rate limit: 10 req/s
    '-c', '5',       // 5 templates paralelos
    '-as',           // automatic scan via wappalyzer
    '-severity', 'low,medium,high,critical',
    '-timeout', '15',
  ], 'nuclei');
  return result.output || '[Nuclei: nenhuma vulnerabilidade detectada pelos templates]';
}

// Download e análise de código-fonte público (JS, HTML) para segredos expostos
async function runTrufflehog(targetUrl: string, tmpDir: string): Promise<string> {
  // TruffleHog escaneando APENAS o diretório de arquivos baixados do alvo
  const result = await runTool(TRUFFLEHOG_BIN, [
    'filesystem',
    '--only-verified',
    '--json',
    tmpDir,
  ], 'trufflehog');

  // Fallback: scan via git se o alvo expõe repositório
  if (!result.output) {
    const gitResult = await runTool(TRUFFLEHOG_BIN, [
      'git', targetUrl,
      '--only-verified',
      '--json',
    ], 'trufflehog-git');
    return gitResult.output || '[TruffleHog: nenhum segredo verificado encontrado no front-end ou .git]';
  }

  return result.output;
}

// Extração manual de JS para análise de chaves, rotas de API e Sourcemaps
async function downloadAndAnalyzeJs(targetUrl: string, tmpDir: string): Promise<string> {
  const findings: string[] = [];

  try {
    // Baixa o HTML principal com WGET_BIN
    const htmlFile = path.join(tmpDir, 'index.html');
    await runTool(WGET_BIN, [
      '-q',
      '--timeout=15',
      '--tries=2',
      '-O', htmlFile,
      targetUrl,
    ], 'wget-html');

    const html = await fs.readFile(htmlFile, 'utf-8').catch(() => '');

    // Extrai URLs de scripts JS do HTML
    const jsUrls = [...html.matchAll(/src=["']([^"']*\.js[^"']*)/gi)]
      .map(m => {
        try {
          return new URL(m[1]!, targetUrl).href;
        } catch { return null; }
      })
      .filter((u): u is string => !!u)
      .slice(0, 15); // máximo 15 arquivos JS

    for (const jsUrl of jsUrls) {
      const jsFile = path.join(tmpDir, `script-${Date.now()}.js`);
      await runTool(WGET_BIN, ['-q', '--timeout=10', '--tries=1', '-O', jsFile, jsUrl], 'wget-js');
      
      // Tenta baixar e extrair Sourcemap
      const mapUrl = jsUrl + '.map';
      const mapFile = jsFile + '.map';
      await runTool(WGET_BIN, ['-q', '--timeout=10', '--tries=1', '-O', mapFile, mapUrl], 'wget-map');

      const jsContent = await fs.readFile(jsFile, 'utf-8').catch(() => '');
      const mapContent = await fs.readFile(mapFile, 'utf-8').catch(() => '');
      
      const contentToAnalyze = jsContent + '\n' + mapContent;
      if (!contentToAnalyze.trim()) continue;

      // Padrões de segredos expostos em JS/Maps
      const patterns: Array<{ label: string; regex: RegExp }> = [
        { label: 'AWS Access Key',       regex: /AKIA[0-9A-Z]{16}/g },
        { label: 'AWS Secret Key',       regex: /(?:aws.{0,20})?["\']([A-Za-z0-9/+=]{40})["\'](?=.*aws)/gi },
        { label: 'Google API Key',       regex: /AIza[0-9A-Za-z_\-]{35}/g },
        { label: 'Firebase URL',         regex: /https:\/\/[a-z0-9-]+\.firebaseio\.com/gi },
        { label: 'Stripe API Key',       regex: /(?:sk|pk)_(?:live|test)_[0-9a-zA-Z]{24,}/g },
        { label: 'Twilio Key',           regex: /SK[0-9a-fA-F]{32}/g },
        { label: 'SendGrid API Key',     regex: /SG\.[a-zA-Z0-9_\-]{22}\.[a-zA-Z0-9_\-]{43}/g },
        { label: 'JWT Token',            regex: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_\-]+/g },
        { label: 'Basic Auth em URL',    regex: /https?:\/\/[^:@\s]+:[^@\s]+@[^\s]+/gi },
        { label: 'Private Key (PEM)',    regex: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g },
        { label: 'Bearer Token hardcoded', regex: /(?:bearer|authorization)["\s:=]+["']([A-Za-z0-9_\-.+/]{20,})['"]/gi },
        { label: 'Endpoint de API interno', regex: /["'](\/api\/v\d[^"']*)['"]/gi },
        { label: 'GraphQL endpoint',     regex: /["'](\/graphql[^"']*)['"]/gi },
        { label: 'Chave genérica exposta', regex: /(?:api[_-]?key|secret|password|token|auth)["\s:=]+["']([A-Za-z0-9_\-.]{8,})['"]/gi },
      ];

      for (const { label, regex } of patterns) {
        const matches = contentToAnalyze.match(regex);
        if (matches) {
          findings.push(`[${label}] encontrado em ${jsUrl}: ${matches.slice(0, 3).join(' | ')}`);
        }
      }
    }

    return findings.length > 0
      ? findings.join('\n')
      : '[Análise JS: nenhum segredo ou rota sensível detectado nos arquivos públicos]';

  } catch (e) {
    log.error({ err: e }, 'Falha durante análise de JS');
    return '[Análise JS: falhou ao processar]';
  }
}

function getMockOutput(tool: string): string {
  const mocks: Record<string, string> = {
    katana: [
      'https://alvo.com/api/v1/users',
      'https://alvo.com/api/v1/products',
      'https://alvo.com/admin/login',
      'https://alvo.com/.env',
      'https://alvo.com/api/v2/orders?user_id=1',
    ].join('\n'),
    gospider: [
      '[url] - [code-200] - https://alvo.com/sitemap.xml',
      '[url] - [code-200] - https://alvo.com/robots.txt',
      '[javascript] - https://alvo.com/static/main.js',
    ].join('\n'),
    nuclei: [
      '[critical] [CVE-2021-44228] [http] https://alvo.com/ [log4j-rce]',
      '[high] [exposure] [http] https://alvo.com/.env [env-file-exposure]',
      '[medium] [misconfig] [http] https://alvo.com/api/v1/ [api-no-auth]',
    ].join('\n'),
    trufflehog: '{"DetectorName":"AWS","Raw":"AKIAIOSFODNN7EXAMPLE","Verified":true}',
    'trufflehog-git': '',
    'wget-html': '',
    'wget-js': '',
    'js-analysis': '[AWS Access Key] encontrado em https://alvo.com/static/app.js: AKIAIOSFODNN7EXAMPLE',
  };
  return mocks[tool] ?? '';
}

const APPSEC_AGENT_SYSTEM_PROMPT = `Você é o AppSec-SecAgent, um especialista em segurança ofensiva e análise de vulnerabilidades web.

Você receberá dados brutos coletados por ferramentas de reconhecimento (Katana, Gospider, Nuclei, TruffleHog, análise estática de JS) contra um alvo web específico.

Sua tarefa é analisar todos os dados, correlacionar evidências e retornar um relatório de segurança estruturado.

## REGRAS ABSOLUTAS:
1. Responda APENAS com o objeto JSON abaixo. Sem texto antes, sem markdown, sem blocos de código.
2. Nunca invente vulnerabilidades. Se não há evidências, retorne findings: [].
3. Classifique a severidade como: "CRITICAL", "HIGH", "MEDIUM", "LOW" ou "INFO".
4. Preencha TODOS os campos do schema — nunca omita campos.

## SCHEMA JSON OBRIGATÓRIO:
{
  "agent_meta": {
    "target_url": "string — URL exata do alvo auditado",
    "scan_timestamp": "string — timestamp ISO 8601",
    "current_phase": "string — ex: 'Reconhecimento + Análise Estática'",
    "tools_used": ["array de strings com as ferramentas executadas"],
    "overall_risk": "CRITICAL | HIGH | MEDIUM | LOW | SAFE"
  },
  "analytical_engine": {
    "detected_tech_stack": ["array — tecnologias identificadas: ex: React, Node.js, Nginx"],
    "exposed_routes": ["array de strings — endpoints descobertos, ex: /api/v1/users"],
    "api_surface": {
      "rest_endpoints": ["array de endpoints REST encontrados"],
      "graphql_endpoints": ["array de endpoints GraphQL, se houver"],
      "auth_mechanism": "string — ex: Bearer JWT, Basic Auth, Cookie Session, Desconhecido"
    },
    "js_analysis_summary": "string — resumo do que foi encontrado nos arquivos JS públicos"
  },
  "findings": [
    {
      "vulnerability_id": "string — ex: SEC-001",
      "title": "string — nome curto da vulnerabilidade",
      "severity": "CRITICAL | HIGH | MEDIUM | LOW | INFO",
      "category": "string — ex: Secret Exposure, Broken Access Control, Misconfiguration, CVE",
      "description": "string — descrição técnica clara do problema",
      "evidence": "string — trecho exato do output da ferramenta que confirmou o achado",
      "affected_url": "string — URL ou endpoint afetado",
      "cve_id": "string | null — ex: CVE-2021-44228, ou null se não aplicável",
      "exploitability": "Easy | Moderate | Hard",
      "impact": "string — descreva o impacto real se explorado"
    }
  ],
  "remediation": {
    "priority_actions": ["array — ações imediatas ordenadas por criticidade"],
    "mitigation_instructions": "string — orientações detalhadas de correção em texto corrido",
    "estimated_effort": "string — ex: 'Alto (refatoração de arquitetura)' ou 'Baixo (rotação de chaves)'"
  }
}`;

export async function runRemoteSecurityAudit(
  targetUrl: string,
  jid: string,
  onProgress?: (msg: string) => Promise<void>
): Promise<string> {

  // Verificação de autorização
  if (!isAuthorizedForSec(jid)) {
    return '🚫 *Acesso negado.* Você não tem permissão para executar auditorias de segurança.';
  }

  // Throttle: bloqueia scans simultâneos do mesmo usuário
  if (activeScans.has(jid)) {
    return '⏳ *Auditoria em andamento.* Aguarde a conclusão do scan anterior antes de iniciar outro.';
  }

  activeScans.add(jid);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sec-audit-'));

  try {
    // Etapa 1: Validação
    await onProgress?.('🔎 *[1/5]* Validando URL e verificando DNS...');
    await validateUrlForScan(targetUrl);

    // Etapa 2: Crawling de endpoints
    await onProgress?.('🕸️ *[2/5]* Mapeando endpoints e rotas da aplicação...');
    const [katanaOutput, gospiderOutput] = await Promise.all([
      runKatana(targetUrl),
      runGospider(targetUrl),
    ]);

    // Etapa 3: Análise de código-fonte (Baixa arquivos para tmpDir)
    await onProgress?.('🔍 *[3/5]* Baixando código-fonte e mapeando Sourcemaps (.js.map)...');
    const jsAnalysis = await downloadAndAnalyzeJs(targetUrl, tmpDir);

    // Roda TruffleHog logo após a conclusão do download, mirando na tmpDir onde os arquivos estão
    const trufflehogOutput = await runTrufflehog(targetUrl, tmpDir);

    // Etapa 4: Scan de vulnerabilidades
    await onProgress?.('⚡ *[4/5]* Executando scan de vulnerabilidades (Nuclei Dynamic)...');
    const nucleiOutput = await runNuclei(targetUrl);

    // Etapa 5: Análise pelo LLM
    await onProgress?.('🤖 *[5/5]* Analisando resultados com AppSec-SecAgent...');

    const userContent = `
URL Alvo: ${targetUrl}
Timestamp: ${new Date().toISOString()}

=== OUTPUT KATANA (Crawling de Rotas) ===
${katanaOutput}

=== OUTPUT GOSPIDER (Links e Assets) ===
${gospiderOutput}

=== ANÁLISE DE CÓDIGO JS (Segredos e Endpoints) ===
${jsAnalysis}

=== OUTPUT TRUFFLEHOG (Segredos Verificados) ===
${trufflehogOutput}

=== OUTPUT NUCLEI (Vulnerabilidades por Template) ===
${nucleiOutput}
    `.trim();

    const response = await callOpenRouterChat({
      systemPrompt: APPSEC_AGENT_SYSTEM_PROMPT,
      userContent,
      maxTokens: 2000,
      temperature: 0.1, // baixa temperatura para respostas factuais e determinísticas
    });

    // Parse seguro do JSON
    const rawText = response.text.replace(/```json|```/g, '').trim();
    let report: any;
    try {
      report = JSON.parse(rawText);
    } catch {
      log.error({ rawText }, 'AppSec-SecAgent retornou JSON inválido');
      return '❌ *Erro interno:* O agente retornou um relatório em formato inválido. Tente novamente.';
    }

    // Registra o scan para auditoria
    log.info({
      jid,
      targetUrl,
      overallRisk: report.agent_meta?.overall_risk,
      findingsCount: report.findings?.length ?? 0,
    }, 'Auditoria de segurança concluída');

    return formatReport(report);

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, jid, targetUrl }, 'Falha na auditoria de segurança');
    return `❌ *Erro ao auditar o site:* ${message}`;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    activeScans.delete(jid);
  }
}

function formatReport(report: any): string {
  const meta      = report.agent_meta        ?? {};
  const engine    = report.analytical_engine ?? {};
  const findings  = report.findings          ?? [];
  const remediation = report.remediation     ?? {};

  const riskEmoji: Record<string, string> = {
    CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡', LOW: '🔵', SAFE: '✅',
  };
  const severityEmoji: Record<string, string> = {
    CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡', LOW: '🔵', INFO: '⚪',
  };

  const lines: string[] = [
    `🛡️ *RELATÓRIO DE SEGURANÇA*`,
    `*Alvo:* ${meta.target_url ?? 'N/A'}`,
    `*Risco Geral:* ${riskEmoji[meta.overall_risk] ?? '⚪'} ${meta.overall_risk ?? 'N/A'}`,
    `*Fase:* ${meta.current_phase ?? 'N/A'}`,
    `*Ferramentas:* ${(meta.tools_used ?? []).join(', ')}`,
    '',
    `🗺️ *SUPERFÍCIE DE ATAQUE*`,
    `*Tecnologias:* ${(engine.detected_tech_stack ?? ['Não identificadas']).join(', ')}`,
    `*Autenticação:* ${engine.api_surface?.auth_mechanism ?? 'Não identificada'}`,
  ];

  const routes = engine.exposed_routes ?? [];
  if (routes.length > 0) {
    lines.push(`*Rotas expostas (${routes.length}):*`);
    routes.slice(0, 8).forEach((r: string) => lines.push(`  • ${r}`));
    if (routes.length > 8) lines.push(`  _...e mais ${routes.length - 8} rotas_`);
  }

  if (engine.js_analysis_summary) {
    lines.push(`*Análise JS:* ${engine.js_analysis_summary}`);
  }

  lines.push('');
  lines.push(`📋 *VULNERABILIDADES ENCONTRADAS (${findings.length})*`);

  if (findings.length === 0) {
    lines.push('✅ Nenhuma vulnerabilidade crítica identificada nas verificações realizadas.');
  } else {
    for (const f of findings) {
      lines.push('');
      lines.push(`${severityEmoji[f.severity] ?? '⚪'} *[${f.severity}] ${f.title}*`);
      if (f.cve_id) lines.push(`  _CVE:_ ${f.cve_id}`);
      lines.push(`  _Categoria:_ ${f.category}`);
      lines.push(`  _URL afetada:_ ${f.affected_url}`);
      lines.push(`  _Descrição:_ ${f.description}`);
      lines.push(`  _Evidência:_ \`${f.evidence}\``);
      lines.push(`  _Exploração:_ ${f.exploitability} | _Impacto:_ ${f.impact}`);
    }
  }

  lines.push('');
  lines.push(`🛠️ *REMEDIAÇÃO*`);
  if ((remediation.priority_actions ?? []).length > 0) {
    lines.push(`*Ações prioritárias:*`);
    remediation.priority_actions.forEach((a: string, i: number) => lines.push(`  ${i + 1}. ${a}`));
  }
  if (remediation.mitigation_instructions) {
    lines.push(`*Orientações:* ${remediation.mitigation_instructions}`);
  }
  if (remediation.estimated_effort) {
    lines.push(`*Esforço estimado:* ${remediation.estimated_effort}`);
  }

  lines.push('');
  lines.push(`_Auditoria realizada em ${new Date().toLocaleString('pt-BR')}_`);

  return lines.join('\n');
}
