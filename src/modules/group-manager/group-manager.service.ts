import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../config/env.js';
import { log } from '../../config/logger.js';
import { prisma } from '../../db/client.js';
import { callOpenRouterChat, OpenRouterUnavailableError } from '../../integrations/openrouter/llm.client.js';
import { transcribeAudio } from '../../integrations/openrouter/whisper.client.js';
import {
  sendWhatsAppGroupText,
  WhatsAppDeliveryError,
  getGroupMetadata,
  type GroupInboundMessage
} from '../../integrations/whatsapp/qr.client.js';
import {
  ANALYST_SYSTEM_PROMPT,
  buildAnalystUserContent,
  buildNewsUserContent,
  NEWS_CURATOR_SYSTEM_PROMPT,
  MEMBER_INTERACTION_SYSTEM_PROMPT,
  MEMBER_EVALUATION_SYSTEM_PROMPT
} from './group-manager.prompt.js';
import { fetchTechNews } from './news-fetcher.js';
import { searchVectorIndex, syncVectorDatabase } from '../../db/vector.js';
import { commitPostmortem, revertLastLearningCommit } from '../../integrations/git/git.js';
import { runRemoteSecurityAudit, isAuthorizedForSec } from '../security-auditor/security-auditor.service.js';

const TRANSCRIBED_AUDIO_PREFIX = '[AUDIO TRANSCRITO]';
const DEFAULT_AUTHOR_LABEL = 'autor_desconhecido';

const SUCCESS_KEYWORDS = ['funcionou', 'deu certo', 'resolvido', 'deploy concluido', 'erro corrigido', 'ajudou', 'vlw hermes', 'obrigado hermes', 'funciona'];

const TECHNICAL_KEYWORDS = [
  'deploy', 'aws', 'servidor', 'banco', 'docker', 'github', 'git', 'bug', 'erro', 
  'travou', 'lento', 'api', 'prisma', 'sqlite', 'cloudflare', 'dns', 'producao', 
  'prod', 'pipeline', 'cicd', 'terraform', 'kubernetes', 'infra', 'devops', 'ssl', 
  'certbot', 'nginx', 'host'
];

let lastBotReplyTimestamp = 0;

function getHermesIdentityPrompt(): string {
  try {
    const filePath = path.resolve(process.cwd(), 'hermes-brain/00_system/identity_prompt.md');
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf8').trim();
    }
  } catch (err) {
    log.warn({ err }, 'Falha ao ler identity_prompt.md do Hermes; usando prompt padrao');
  }

  return `Você é o Genisis, um Engenheiro de Software Sênior, DevOps e Especialista em Infraestrutura/Cloud da Aithos Tech (aithostech.com.br).
Você atua como um agente autônomo de suporte técnico onipresente no grupo.
Seu método de aprendizado e auto-evolução é baseado na Arquitetura Hermes (RAG-as-filesystem e pós-mortens).
Diretrizes:
1. Identifique-se sempre como Genisis.
2. Seu tom deve ser profissional, técnico, direto e extremamente prestativo.
3. Use explicações claras em Markdown. Use emojis de computador/análise (💻, 📊, 📈, 📉, ⚙️, 🛠️) com moderação.`;
}

async function retrieveHermesKnowledge(body: string): Promise<string> {
  const retrievedContents: string[] = [];

  try {
    const matchingFiles = await searchVectorIndex(body, 'knowledge', 3);
    for (const relativePath of matchingFiles) {
      const fullPath = path.resolve(process.cwd(), relativePath);
      if (fs.existsSync(fullPath)) {
        retrievedContents.push(`### Arquivo: ${path.basename(relativePath)}\n${fs.readFileSync(fullPath, 'utf8')}`);
      }
    }

    const matchingPostmortems = await searchVectorIndex(body, 'postmortem', 3);
    for (const relativePath of matchingPostmortems) {
      const fullPath = path.resolve(process.cwd(), relativePath);
      if (fs.existsSync(fullPath)) {
        retrievedContents.push(`### Postmortem: ${path.basename(relativePath)}\n${fs.readFileSync(fullPath, 'utf8')}`);
      }
    }
  } catch (err) {
    log.warn({ err }, 'Erro ao ler arquivos do hermes-brain para RAG vetorial');
  }

  if (retrievedContents.length === 0) return '';
  return `\n---\nCONHECIMENTO RECUPERADO (RAG Vetorial SQLite):\n${retrievedContents.join('\n\n')}\n---\n`;
}

export function checkProactiveResponseTrigger(body: string): boolean {
  if (!env.HERMES_PROACTIVE_ENABLED) return false;

  const normalized = body.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  const hasTechKeyword = TECHNICAL_KEYWORDS.some((kw) => normalized.includes(kw));
  if (!hasTechKeyword) return false;

  const timeSinceLastReply = (Date.now() - lastBotReplyTimestamp) / 1000;
  if (timeSinceLastReply < env.HERMES_COOLDOWN_SEC) {
    log.debug(
      { timeSinceLastReply, cooldown: env.HERMES_COOLDOWN_SEC },
      'Trigger proativo ignorado: cooldown ativo'
    );
    return false;
  }

  const isQuestion = normalized.includes('?') || /\b(como|onde|qual|por que|quem|quando|ajuda|duvida|problema)\b/i.test(normalized);
  if (isQuestion) {
    log.info('Trigger proativo ativado: pergunta tecnica detectada (probabilidade 100%)');
    return true;
  }

  const roll = Math.random();
  const triggered = roll < env.HERMES_PROACTIVE_PROBABILITY;
  log.debug(
    { roll, threshold: env.HERMES_PROACTIVE_PROBABILITY, triggered },
    'Verificacao de probabilidade do trigger proativo'
  );

  return triggered;
}

export async function saveHermesPostmortem(groupId: string, messageBody: string): Promise<string | null> {
  try {
    const recentMessages = await fetchRecentHistory(groupId);
    if (recentMessages.length < 2) return null;

    const formattedHistory = recentMessages
      .map((msg) => `[${msg.author}]: ${msg.body}`)
      .join('\n');

    const systemPrompt = `Você é o Genisis, Engenheiro de Software Sênior e DevOps da Aithos Tech.
Você está analisando o histórico recente de um chat de grupo onde um problema técnico foi discutido e resolvido.
Sua missão é extrair esse aprendizado e gerar um relatório técnico de "Postmortem" estruturado em Markdown (método Hermes).

O Markdown gerado deve conter:
- Título principal no formato: "# Postmortem #<id_curto>: <Nome do Problema resolvido>"
- Seção "## Problema": O que ocorreu e como foi relatado.
- Seção "## Causa Raiz": Por que o erro aconteceu.
- Seção "## Solução": Quais passos resolveram o problema.

Seja técnico, conciso e profissional.`;

    const userContent = `Histórico recente de mensagens para análise:\n\n${formattedHistory}\n\nMensagem final de sucesso: ${messageBody}`;

    const llm = await callOpenRouterChat({
      systemPrompt,
      userContent,
      maxTokens: 2500,
      temperature: 0.3
    });

    const markdownContent = llm.text.trim();
    if (!markdownContent) return null;

    const filename = `bug_${Date.now()}.md`;
    const folderPath = path.resolve(process.cwd(), 'hermes-brain/05_postmortems');
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }
    const filePath = path.join(folderPath, filename);
    fs.writeFileSync(filePath, markdownContent, 'utf8');

    try {
      await commitPostmortem(filePath);
    } catch (gitErr) {
      log.error({ err: gitErr, filePath }, 'Erro ao fazer commit do postmortem no Git');
    }

    try {
      await syncVectorDatabase();
    } catch (syncErr) {
      log.error({ err: syncErr }, 'Erro ao sincronizar banco vetorial após salvar postmortem');
    }

    log.info({ filePath }, 'Postmortem de auto-aprendizado (Self-Learning) salvo com sucesso');
    return filename;
  } catch (err) {
    log.error({ err }, 'Erro ao gerar postmortem de auto-aprendizado');
    return null;
  }
}

function listCommands(): string[] {
  return env.GROUP_MANAGER_COMMANDS.split(',').map((cmd) => cmd.trim().toLowerCase()).filter(Boolean);
}

function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function buildMentionRegex(): RegExp {
  const configured = env.GROUP_MANAGER_BOT_MENTION
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/^@\s*/, '')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const variations = new Set<string>();
  if (configured) variations.add(configured);
  variations.add('genesis');
  variations.add('genisis');
  variations.add('genisi');
  variations.add('genesi');
  variations.add('aithos');
  variations.add('aithostech');

  const escapedVariations = Array.from(variations).map(v => 
    v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  );
  escapedVariations.push('aithos\\s+tech');

  const pattern = escapedVariations.join('|');
  return new RegExp(`(^|\\s)@\\s*(${pattern})([\\s,:!?]|$)`, 'i');
}

export function detectGroupTrigger(body: string, isBotMentioned?: boolean): { triggered: boolean; command: string | null; mentionOnly: boolean } {
  const normalized = normalizeText(body);
  if (!normalized.trim() && !isBotMentioned) return { triggered: false, command: null, mentionOnly: false };

  const hasMention = Boolean(isBotMentioned) || buildMentionRegex().test(normalized);
  const commands = listCommands();
  const matchedCommand = commands.find((cmd) => {
    const regex = new RegExp(`(^|\\s)${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`);
    return regex.test(normalized);
  });

  if (matchedCommand) {
    return { triggered: true, command: matchedCommand, mentionOnly: false };
  }
  if (hasMention) {
    return { triggered: true, command: null, mentionOnly: true };
  }
  return { triggered: false, command: null, mentionOnly: false };
}

export function isTestCommand(body: string, isBotMentioned?: boolean): boolean {
  const normalized = normalizeText(body);
  const testCommands = ['!teste', '!test'];
  const hasTestCommand = testCommands.some((cmd) => {
    const regex = new RegExp(`(^|\\s)${cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s,:!?]|$)`);
    return regex.test(normalized);
  });

  if (hasTestCommand) return true;

  const hasMention = Boolean(isBotMentioned) || buildMentionRegex().test(normalized);
  if (hasMention) {
    const testKeywords = ['teste', 'test', 'ping', 'status', 'ativo'];
    return testKeywords.some((word) => {
      const regex = new RegExp(`(^|\\s)${word}([\\s,:!?]|$)`);
      return regex.test(normalized);
    });
  }

  return false;
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '--:--';
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function buildHistoryLineInternal(row: { author: string; body: string; media_type: string; created_at: Date }): string {
  const author = row.author || DEFAULT_AUTHOR_LABEL;
  const isAudio = row.media_type === 'audio' || row.body.startsWith(TRANSCRIBED_AUDIO_PREFIX);
  const body = isAudio && !row.body.startsWith(TRANSCRIBED_AUDIO_PREFIX)
    ? `${TRANSCRIBED_AUDIO_PREFIX} ${row.body}`
    : row.body;
  return `[${author} - ${formatTimestamp(row.created_at.getTime())}]: ${body}`;
}

export const buildHistoryLine = buildHistoryLineInternal;

export async function storeGroupMessage(input: {
  groupId: string;
  author: string;
  authorPhone: string | null;
  body: string;
  mediaType: string;
  whatsappId: string | null;
}): Promise<void> {
  await prisma.groupMessage.create({
    data: {
      group_id: input.groupId,
      author: input.author,
      author_phone: input.authorPhone,
      body: input.body,
      media_type: input.mediaType,
      whatsapp_id: input.whatsappId,
      is_from_bot: false
    }
  });
}

async function fetchRecentHistory(groupId: string): Promise<Array<{ author: string; body: string; media_type: string; created_at: Date }>> {
  const since = new Date(Date.now() - env.GROUP_MANAGER_HISTORY_HOURS * 60 * 60 * 1000);
  return prisma.groupMessage.findMany({
    where: {
      group_id: groupId,
      created_at: { gte: since }
    },
    orderBy: { created_at: 'asc' },
    take: env.GROUP_MANAGER_HISTORY_LIMIT,
    select: {
      author: true,
      body: true,
      media_type: true,
      created_at: true
    }
  });
}

export async function generateGroupSummary(input: {
  groupId: string;
  triggeredBy: string;
}): Promise<string> {
  const rows = await fetchRecentHistory(input.groupId);
  const historyLines = rows.map(buildHistoryLineInternal);

  const llm = await callOpenRouterChat({
    systemPrompt: ANALYST_SYSTEM_PROMPT,
    userContent: buildAnalystUserContent({
      historyLines,
      triggeredBy: input.triggeredBy
    }),
    maxTokens: 2500,
    temperature: 0.2
  });

  return llm.text.trim() || 'Sem dados suficientes para gerar resumo no momento.';
}

export async function generateDailyNewsDigest(): Promise<{ text: string; sources: string[] }> {
  const news = await fetchTechNews(env.GROUP_MANAGER_NEWS_TOP_N);
  const llm = await callOpenRouterChat({
    systemPrompt: NEWS_CURATOR_SYSTEM_PROMPT,
    userContent: buildNewsUserContent(news.rawText),
    maxTokens: 2500,
    temperature: 0.5
  });
  return {
    text: llm.text.trim() || 'Sem destaques tech para hoje. Falem com o time!',
    sources: news.sourcesUsed
  };
}

async function sendReply(groupId: string, text: string): Promise<void> {
  lastBotReplyTimestamp = Date.now();
  try {
    await sendWhatsAppGroupText(groupId, text);
  } catch (err) {
    if (err instanceof WhatsAppDeliveryError) {
      log.warn(
        { groupId, code: err.code, reason: err.message },
        'Resposta do gerente nao entregue ao grupo'
      );
    } else {
      log.error({ err, groupId }, 'Falha inesperada ao responder grupo');
    }
  }
}

export async function runMemberEvaluation(input: {
  groupId: string;
  body: string;
  triggeredBy: string;
}): Promise<string> {
  const match = input.body.match(/!avaliar\s+@?([^\s]+)/i);
  const targetMember = (match && match[1]) ? match[1].trim() : null;

  if (!targetMember) {
    return [
      `💻 *[Hermes] Erro de Avaliação*`,
      ``,
      `Por favor, especifique o membro a ser avaliado.`,
      `Exemplo: \`!avaliar Nathan\` ou \`!avaliar @Nathan\``
    ].join('\n');
  }

  const messages = await prisma.groupMessage.findMany({
    where: {
      group_id: input.groupId,
      author: {
        contains: targetMember
      }
    },
    orderBy: { created_at: 'desc' },
    take: 50,
    select: {
      author: true,
      body: true,
      created_at: true
    }
  });

  if (messages.length === 0) {
    return `💻 *[Hermes] Avaliação Pessoal*\n\nNão foram encontradas mensagens recentes do membro *${targetMember}* neste grupo para realizar a avaliação.`;
  }

  const formattedMessages = messages
    .reverse()
    .map((msg) => `[${msg.author} - ${formatTimestamp(msg.created_at.getTime())}]: ${msg.body}`)
    .join('\n');

  const llm = await callOpenRouterChat({
    systemPrompt: MEMBER_EVALUATION_SYSTEM_PROMPT,
    userContent: `Avaliar o seguinte historico de mensagens do membro ${targetMember}:\n\n${formattedMessages}`,
    maxTokens: 3000,
    temperature: 0.3
  });

  const evaluationText = llm.text.trim();

  await prisma.memberEvaluation.create({
    data: {
      group_id: input.groupId,
      member_name: targetMember,
      evaluation: evaluationText
    }
  });

  return [
    `💻 *[Hermes] Avaliação Pessoal Processada*`,
    ``,
    `📊 A avaliação de desempenho e atividade do membro *${targetMember}* foi concluída com sucesso.`,
    `1️⃣ *Período de Análise:* Últimas ${messages.length} mensagens`,
    `2️⃣ *Ação:* Os dados analíticos foram arquivados com sucesso no banco de dados da Aithos Tech.`,
    `3️⃣ *Destino:* Apenas armazenado para fins de gestão interna.`
  ].join('\n');
}

export async function generateGroupAnswer(input: {
  groupId: string;
  userQuestion: string;
  triggeredBy: string;
  mediaBuffer?: Buffer | null;
  mediaMimeType?: string | null;
}): Promise<string> {
  const rows = await fetchRecentHistory(input.groupId);
  const historyLines = rows.map(buildHistoryLineInternal);

  const identityPrompt = getHermesIdentityPrompt();
  const retrievedKnowledge = await retrieveHermesKnowledge(input.userQuestion);
  const systemPrompt = `${identityPrompt}\n${retrievedKnowledge}`;

  let userContentPayload: string | any[] = [
    `Usuario: ${input.triggeredBy}`,
    `Pergunta/Comentario: ${input.userQuestion || '(analise da imagem)'}`,
    '',
    'Historico recente do grupo:',
    ...historyLines
  ].join('\n');

  let modelOverride: string | undefined;

  if (input.mediaBuffer && input.mediaMimeType?.startsWith('image/')) {
    const base64Image = input.mediaBuffer.toString('base64');
    const dataUrl = `data:${input.mediaMimeType};base64,${base64Image}`;
    userContentPayload = [
      {
        type: 'text',
        text: [
          `Usuario: ${input.triggeredBy}`,
          `Pergunta/Comentario: ${input.userQuestion || 'Por favor, analise a imagem/print de erro anexada.'}`,
          '',
          'Historico recente do grupo:',
          ...historyLines
        ].join('\n')
      },
      {
        type: 'image_url',
        image_url: {
          url: dataUrl
        }
      }
    ];
    modelOverride = 'openrouter/free';
  }

  const llm = await callOpenRouterChat({
    systemPrompt,
    userContent: userContentPayload,
    maxTokens: 3000,
    temperature: 0.3,
    ...(modelOverride ? { model: modelOverride } : {})
  });

  return llm.text.trim() || 'Desculpe, nao consegui processar uma resposta no momento.';
}

async function handleMentionedCommand(input: GroupInboundMessage): Promise<void> {
  const isAvaliar = normalizeText(input.body).includes('!avaliar');
  const trigger = detectGroupTrigger(input.body, input.isBotMentioned);

  if (!isAvaliar && !trigger.triggered) return;
  if (env.GROUP_MANAGER_TARGET_GROUP_ID && input.groupId !== env.GROUP_MANAGER_TARGET_GROUP_ID) return;

  const triggeredBy = input.authorName ?? input.authorPhone ?? input.authorId;

  log.info(
    {
      groupId: input.groupId,
      author: triggeredBy,
      command: isAvaliar ? '!avaliar' : trigger.command,
      mentionOnly: trigger.mentionOnly
    },
    'Gerente de grupo acionado por mencao/comando'
  );

  try {
    let reply = '';
    if (isAvaliar) {
      reply = await runMemberEvaluation({
        groupId: input.groupId,
        body: input.body,
        triggeredBy
      });
    } else if (trigger.mentionOnly) {
      reply = await generateGroupAnswer({
        groupId: input.groupId,
        userQuestion: input.body,
        triggeredBy,
        mediaBuffer: input.mediaBuffer,
        mediaMimeType: input.mediaMimeType
      });
    } else {
      reply = await generateGroupSummary({
        groupId: input.groupId,
        triggeredBy
      });
    }
    await sendReply(input.groupId, reply);
  } catch (err) {
    if (err instanceof OpenRouterUnavailableError) {
      log.error({ err, groupId: input.groupId }, 'OpenRouter indisponivel para responder');
      await sendReply(input.groupId, 'Nao consegui processar sua solicitacao agora. Tente novamente em alguns minutos.');
    } else {
      log.error({ err, groupId: input.groupId }, 'Falha ao processar interacao do grupo');
      await sendReply(input.groupId, 'Ocorreu um erro interno ao processar seu comando. Tente novamente mais tarde.');
    }
  }
}

export async function handleGroupInboundMessage(msg: GroupInboundMessage): Promise<void> {
  if (!env.GROUP_MANAGER_ENABLED) return;

  const trimmedMessage = msg.body.trim();
  // --- HANDLER !sec ---
  const secMatch = trimmedMessage.match(/^!sec\s+(https?:\/\/\S+)/i);
  if (secMatch && secMatch[1]) {
    const targetUrl = secMatch[1].trim();
    // Identificador unificado para autor no grupo
    const senderJid = msg.authorId ?? msg.authorPhone ?? '';

    if (!isAuthorizedForSec(senderJid)) {
      await sendWhatsAppGroupText(msg.groupId, '🚫 Você não tem permissão para usar o comando !sec.');
      return;
    }

    await sendWhatsAppGroupText(
      msg.groupId,
      `🔍 *Iniciando auditoria de segurança para:*\n${targetUrl}\n\n_Isso pode levar até 2 minutos. Você receberá atualizações de progresso._`
    );

    try {
      const report = await runRemoteSecurityAudit(
        targetUrl,
        senderJid,
        async (progressMsg) => {
          await sendWhatsAppGroupText(msg.groupId, progressMsg);
        }
      );
      await sendWhatsAppGroupText(msg.groupId, report);
    } catch (err) {
      log.error({ err, groupId: msg.groupId, targetUrl }, 'Erro inesperado no handler !sec (grupo)');
      await sendWhatsAppGroupText(msg.groupId, '❌ Ocorreu um erro inesperado durante a auditoria. Tente novamente.');
    }

    return; // impede processamento por outros handlers
  }
  // --- FIM HANDLER !sec ---

  // --- HANDLER !imagem ---
  const imageMatch = trimmedMessage.match(/^!imagem\s+(.+)/i);
  if (imageMatch && imageMatch[1]) {
    const prompt = imageMatch[1].trim();
    
    await sendWhatsAppGroupText(
      msg.groupId,
      `🎨 *Gerando imagem para:* "${prompt}"\n_Aguarde um momento..._`
    );

    try {
      const { sendWhatsAppGroupImage } = await import('../../integrations/whatsapp/qr.client.js');
      
      if (!env.HF_TOKEN) {
        throw new Error('MISSING_HF_TOKEN');
      }

      const hfUrl = 'https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell';
      const response = await fetch(hfUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.HF_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ inputs: prompt })
      });
      
      if (!response.ok) {
        throw new Error(`Falha ao gerar imagem no HF: ${response.status} ${response.statusText}`);
      }
      
      const arrayBuffer = await response.arrayBuffer();
      const base64Data = Buffer.from(arrayBuffer).toString('base64');
      
      await sendWhatsAppGroupImage(msg.groupId, base64Data, `🎨 Imagem gerada para: *${prompt}*`);
    } catch (err) {
      log.error({ err, groupId: msg.groupId, prompt }, 'Erro no handler !imagem');
      const errorMsg = err instanceof Error ? err.message : 'Erro desconhecido';
      
      if (errorMsg === 'MISSING_HF_TOKEN') {
        await sendWhatsAppGroupText(msg.groupId, '❌ *Geração de Imagem requer configuração.*\nA API gratuita bloqueou os acessos. Para voltar a gerar imagens, você precisa criar uma conta grátis em *huggingface.co*, ir em Settings > Access Tokens, criar um token e colocar no arquivo `.env` como `HF_TOKEN=seu_token`.');
      } else {
        await sendWhatsAppGroupText(msg.groupId, '❌ Ocorreu um erro ao gerar a imagem pela API. Tente outro prompt ou aguarde.');
      }
    }

    return; // impede processamento por outros handlers
  }
  // --- FIM HANDLER !imagem ---

  const isTest = isTestCommand(msg.body, msg.isBotMentioned);

  if (!isTest && env.GROUP_MANAGER_TARGET_GROUP_ID && msg.groupId !== env.GROUP_MANAGER_TARGET_GROUP_ID) {
    log.debug({ groupId: msg.groupId, target: env.GROUP_MANAGER_TARGET_GROUP_ID }, 'Mensagem de grupo ignorada (nao eh o grupo alvo)');
    return;
  }

  if (isTest) {
    log.info({ groupId: msg.groupId, from: msg.authorName ?? msg.authorId }, 'Comando de teste do Gerente de Grupo acionado');
    try {
      const groupMeta = await getGroupMetadata(msg.groupId);
      const groupName = groupMeta?.name ?? 'Nome Indisponivel';
      const author = msg.authorName ?? msg.authorPhone ?? msg.authorId;
      const authorPhone = msg.authorPhone ?? 'Nao informado';

      const replyText = [
        `💻 *[Genisis] Bot de Gerenciamento de Grupo Ativo*`,
        ``,
        `Para configurar este grupo no arquivo \`.env\` do seu SDR Agent, use as seguintes definicoes:`,
        `\`\`\``,
        `GROUP_MANAGER_ENABLED=true`,
        `GROUP_MANAGER_TARGET_GROUP_ID=${msg.groupId}`,
        `GROUP_MANAGER_BOT_MENTION=${env.GROUP_MANAGER_BOT_MENTION}`,
        `\`\`\``,
        ``,
        `📊 *Informacoes de Analise do Grupo:*`,
        `1️⃣ *ID do Grupo:* ${msg.groupId}`,
        `2️⃣ *Nome do Grupo:* ${groupName}`,
        `3️⃣ *Solicitado por:* ${author} (${authorPhone})`,
        `4️⃣ *Status de Monitoramento:* ${
          env.GROUP_MANAGER_TARGET_GROUP_ID === msg.groupId
            ? 'Ativo e Monitorando 📈'
            : 'Inativo (ID diferente do configurado in GROUP_MANAGER_TARGET_GROUP_ID) 📉'
        }`
      ].join('\n');

      await sendReply(msg.groupId, replyText);
    } catch (err) {
      log.error({ err, groupId: msg.groupId }, 'Falha ao processar comando de teste do grupo');
      try {
        await sendReply(msg.groupId, `💻 *[Genisis] Bot de Gerenciamento de Grupo Ativo*\n\n1️⃣ *ID do Grupo:* ${msg.groupId}\n(Nao foi possivel carregar todos os metadados do grupo)`);
      } catch (sendErr) {
        log.error({ err: sendErr }, 'Falha ao enviar resposta basica de erro de teste');
      }
    }
    return;
  }

  const author = msg.authorName ?? msg.authorPhone ?? msg.authorId;

  let body = msg.body;
  let mediaType = msg.type ?? 'chat';

  if (msg.hasMedia && env.GROUP_MANAGER_TRANSCRIBE_AUDIO && msg.mediaBuffer && (msg.type === 'ptt' || msg.type === 'audio' || msg.mediaMimeType?.startsWith('audio/'))) {
    try {
      const transcription = await transcribeAudio({
        audio: msg.mediaBuffer,
        filename: msg.mediaFilename ?? 'audio.ogg',
        mimeType: msg.mediaMimeType ?? 'audio/ogg; codecs=opus',
        language: 'pt'
      });
      const transcribed = transcription.text.trim();
      if (transcribed) {
        body = body ? `${body}\n${TRANSCRIBED_AUDIO_PREFIX} ${transcribed}` : `${TRANSCRIBED_AUDIO_PREFIX} ${transcribed}`;
        mediaType = 'audio';
      }
    } catch (err) {
      log.warn({ err, groupId: msg.groupId }, 'Falha ao transcrever audio do grupo; mensagem sera salva como texto');
    }
  } else if (msg.hasMedia) {
    if (msg.mediaMimeType?.startsWith('image/')) {
      mediaType = 'image';
    } else {
      mediaType = msg.type ?? 'media';
    }
  }

  if (!body.trim() && !msg.hasMedia) {
    log.debug({ groupId: msg.groupId, author, type: mediaType }, 'Mensagem de grupo sem corpo textual nem imagem; ignorada');
    return;
  }

  const storedBody = body || (mediaType === 'image' ? '(imagem)' : '(media)');

  try {
    await storeGroupMessage({
      groupId: msg.groupId,
      author,
      authorPhone: msg.authorPhone,
      body: storedBody,
      mediaType,
      whatsappId: msg.whatsappId
    });
  } catch (err) {
    log.error({ err, groupId: msg.groupId, author }, 'Falha ao salvar mensagem do grupo');
  }

  const normalizedBody = normalizeText(body);
  const isMention = msg.isBotMentioned || buildMentionRegex().test(normalizedBody) || normalizedBody.includes('genisis') || normalizedBody.includes('genesis') || normalizedBody.includes('geninis') || normalizedBody.includes('hermes');

  // Check for rollback command or negative feedback
  const isRollbackCommand = isMention && (
    normalizedBody.includes('reverter') ||
    normalizedBody.includes('rollback') ||
    normalizedBody.includes('desfazer')
  );

  const NEGATIVE_FEEDBACK_KEYWORDS = ['isso estava errado', 'não funcionou', 'nao funcionou', 'resposta ruim', 'remover aprendizado'];
  const isNegativeFeedback = NEGATIVE_FEEDBACK_KEYWORDS.some((kw) => normalizedBody.includes(kw)) && isMention;

  if (isRollbackCommand || isNegativeFeedback) {
    log.info({ groupId: msg.groupId, body, isRollbackCommand, isNegativeFeedback }, 'Rollback ou Feedback negativo acionado');
    try {
      const revertedHash = await revertLastLearningCommit();
      if (revertedHash) {
        await syncVectorDatabase();
        const reason = isRollbackCommand ? 'Solicitação de reversão manual' : 'Feedback negativo recebido';
        await sendReply(msg.groupId, `⚠️ *[Genisis] Aprendizado Revertido*\n\nIdentifiquei a necessidade de reverter o último aprendizado registrado (${reason}). O último relatório de pós-morte foi removido com sucesso e descartado do meu cérebro de commits git! 🧠⚙️`);
        return;
      } else {
        await sendReply(msg.groupId, `💻 *[Genisis] Nenhum aprendizado encontrado*\n\nNão encontrei nenhum relatório de pós-morte recente registrado na minha base de conhecimentos para reverter no momento.`);
        return;
      }
    } catch (err) {
      log.error({ err, groupId: msg.groupId }, 'Falha ao processar rollback de aprendizado');
      await sendReply(msg.groupId, `❌ *[Genisis] Erro no Rollback*\n\nOcorreu um erro técnico ao tentar reverter o último aprendizado do repositório Git.`);
      return;
    }
  }

  // 1. Check for success keywords and Bot trigger -> Self-Learning (Processo de Evolução)
  const isSelfLearningTrigger = SUCCESS_KEYWORDS.some((kw) => normalizedBody.includes(kw)) && isMention;

  if (isSelfLearningTrigger) {
    log.info({ groupId: msg.groupId, body }, 'Trigger de auto-aprendizado (Self-Learning) acionado');
    const postmortemFile = await saveHermesPostmortem(msg.groupId, body);
    if (postmortemFile) {
      await sendReply(msg.groupId, `💻 *[Genisis] Aprendizado Registrado*\n\nEntendido! Analisei nossa conversa recente e salvei um relatório técnico de pós-morte (*${postmortemFile}*) na minha base de conhecimentos local (\`/hermes-brain/05_postmortems/\`) para aprimorar meus atendimentos e consultas futuras! 📈`);
      return;
    }
  }

  // 2. Check direct mention / commands
  const isAvaliar = normalizeText(body).includes('!avaliar');
  const trigger = detectGroupTrigger(body, msg.isBotMentioned);

  if (isAvaliar || trigger.triggered) {
    await handleMentionedCommand({
      ...msg,
      body,
      type: mediaType
    });
    return;
  }

  // 3. Proactive Technical Response Check (Conversar sem mencionar)
  if (checkProactiveResponseTrigger(body)) {
    log.info({ groupId: msg.groupId, body }, 'Trigger proativo acionado para discussao tecnica');
    try {
      const reply = await generateGroupAnswer({
        groupId: msg.groupId,
        userQuestion: body,
        triggeredBy: author,
        mediaBuffer: msg.mediaBuffer,
        mediaMimeType: msg.mediaMimeType
      });
      await sendReply(msg.groupId, reply);
    } catch (err) {
      log.error({ err, groupId: msg.groupId }, 'Falha ao processar resposta proativa do Hermes');
    }
  }
}
