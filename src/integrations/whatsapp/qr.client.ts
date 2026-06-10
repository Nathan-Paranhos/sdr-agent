import path from 'node:path';
import qrcode from 'qrcode-terminal';
import whatsappWeb from 'whatsapp-web.js';
import cron, { ScheduledTask } from 'node-cron';
import { env } from '../../config/env.js';
import { log } from '../../config/logger.js';

let healthCheckTask: ScheduledTask | null = null;
let wasConnected = true;

function startHealthCheck(): void {
  if (healthCheckTask) {
    healthCheckTask.stop();
  }

  healthCheckTask = cron.schedule('*/1 * * * *', async () => {
    if (!client || !ready) {
      if (wasConnected) {
        log.warn('Health Check: WhatsApp Client nao esta pronto ou nulo');
        wasConnected = false;
      }
      return;
    }

    try {
      const state = await client.getState();
      if (state !== 'CONNECTED') {
        if (wasConnected) {
          log.warn({ state }, 'Health Check: WhatsApp Client detectou desconexao ou estado nao conectado');
          wasConnected = false;
        }
      } else {
        if (!wasConnected) {
          log.info('Health Check: WhatsApp Client reestabeleceu conexao');
          wasConnected = true;
          if (env.GROUP_MANAGER_TARGET_GROUP_ID) {
            try {
              await sendWhatsAppGroupText(
                env.GROUP_MANAGER_TARGET_GROUP_ID,
                `⚠️ *[Genisis] Alerta de Conexão: Conexão com o WhatsApp restabelecida com sucesso! O bot está ativo novamente e monitorando o grupo.*`
              );
            } catch (err) {
              log.error({ err }, 'Falha ao enviar alerta de conexao reestabelecida para o grupo');
            }
          }
        }
      }
    } catch (err) {
      log.error({ err }, 'Erro ao consultar estado do cliente WhatsApp no Health Check');
      if (wasConnected) {
        wasConnected = false;
      }
    }
  });

  log.info('Health Check do WhatsApp Client iniciado (intervalo: 1 min)');
}

function stopHealthCheck(): void {
  if (healthCheckTask) {
    healthCheckTask.stop();
    healthCheckTask = null;
  }
}
import type { InboundMessage } from '../../modules/conversation/conversation.service.js';
import type { Client as WhatsAppClient, Message } from 'whatsapp-web.js';
import { analyzeCvAndMatchJobs } from '../../modules/hr/hr.service.js';

type InboundHandler = (message: InboundMessage) => Promise<void>;
type CsvIngestSummary = { received: number; processing: number; quarantine: number; failed?: number };
type AdminCsvHandler = (csv: string) => Promise<CsvIngestSummary>;

export interface GroupInboundMessage {
  groupId: string;
  authorId: string;
  authorName: string | null;
  authorPhone: string | null;
  body: string;
  type: string;
  hasMedia: boolean;
  mediaBuffer: Buffer | null;
  mediaMimeType: string | null;
  mediaFilename: string | null;
  whatsappId: string | null;
  timestamp: number;
  isBotMentioned?: boolean;
}

type GroupInboundHandler = (message: GroupInboundMessage) => Promise<void>;

export class WhatsAppDeliveryError extends Error {
  constructor(
    public readonly code: 'number_not_registered' | 'send_failed' | 'not_ready',
    public readonly phone: string,
    message: string
  ) {
    super(message);
    this.name = 'WhatsAppDeliveryError';
  }
}

export interface WhatsAppHandlers {
  onInbound: InboundHandler;
  onAdminCsv: AdminCsvHandler;
  onGroupInbound?: GroupInboundHandler;
}

const { Client, LocalAuth } = whatsappWeb;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const IS_LINUX = process.platform === 'linux';
const PROCESSED_TTL_MS = 10 * 60 * 1000;
const RECONNECT_DELAY_MS = 10_000;

const processedMessages = new Set<string>();

let client: WhatsAppClient | null = null;
let ready = false;
let startPromise: Promise<void> | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let restartPromise: Promise<void> | null = null;
let stopping = false;

function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (!digits) throw new Error(`Telefone invalido: ${phone}`);
  return `+${digits}`;
}

function samePhone(a: string, b: string): boolean {
  return a.replace(/\D/g, '') === b.replace(/\D/g, '');
}

function toChatId(phone: string): string {
  return `${normalizePhone(phone).replace(/\D/g, '')}@c.us`;
}

async function resolveSendChatId(phone: string): Promise<string> {
  if (!client || !ready) {
    throw new WhatsAppDeliveryError('not_ready', phone, 'WhatsApp ainda nao esta pronto para envio');
  }

  const digits = normalizePhone(phone).replace(/\D/g, '');
  let registered: { _serialized?: string } | null;
  try {
    registered = await client.getNumberId(digits);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new WhatsAppDeliveryError('send_failed', phone, message);
  }

  if (!registered?._serialized) {
    throw new WhatsAppDeliveryError('number_not_registered', phone, 'Numero nao encontrado no WhatsApp');
  }

  return registered._serialized;
}

function isPhoneChatId(id: string | undefined): boolean {
  return Boolean(id?.endsWith('@c.us') || id?.endsWith('@s.whatsapp.net'));
}

function isLidChatId(id: string | undefined): boolean {
  return Boolean(id?.endsWith('@lid'));
}

function addChatIdCandidate(chatId: string | undefined, phones: Set<string>, lids: Set<string>): void {
  if (!chatId) return;
  if (isPhoneChatId(chatId)) phones.add(chatId);
  if (isLidChatId(chatId)) lids.add(chatId);
}

function looksLikeCsv(text: string): boolean {
  const firstLine = text.trim().split(/\r?\n/)[0]?.toLowerCase() ?? '';
  return firstLine.includes(',') && (firstLine.includes('company_name') || firstLine.includes('empresa')) && (firstLine.includes('phone') || firstLine.includes('telefone') || firstLine.includes('whatsapp'));
}

function markProcessed(messageId: string): boolean {
  if (processedMessages.has(messageId)) return false;
  processedMessages.add(messageId);
  setTimeout(() => processedMessages.delete(messageId), PROCESSED_TTL_MS);
  return true;
}

async function resolvePhoneFromLid(lid: string): Promise<string | null> {
  if (!client) return null;

  try {
    const [mapped] = await client.getContactLidAndPhone([lid]);
    if (mapped?.pn) return normalizePhone(mapped.pn);
  } catch (err) {
    log.debug({ err, lid }, 'Falha ao converter WhatsApp LID para telefone');
  }

  return null;
}

async function resolveInboundPhone(msg: Message): Promise<string | null> {
  const lidCandidates = new Set<string>();
  const phoneCandidates = new Set<string>();
  let contactNumberFallback: string | null = null;

  addChatIdCandidate(msg.from, phoneCandidates, lidCandidates);
  addChatIdCandidate(msg.id?.remote, phoneCandidates, lidCandidates);

  try {
    const contact = await msg.getContact();
    const contactId = contact.id?._serialized;
    addChatIdCandidate(contactId, phoneCandidates, lidCandidates);

    if (contact.number && !isLidChatId(contactId)) {
      contactNumberFallback = contact.number;
    }
  } catch (err) {
    log.debug({ err }, 'Falha ao resolver contato pelo WhatsApp');
  }

  for (const phone of phoneCandidates) {
    return normalizePhone(phone);
  }

  for (const lid of lidCandidates) {
    const phone = await resolvePhoneFromLid(lid);
    if (phone) return phone;
  }

  if (contactNumberFallback) return normalizePhone(contactNumberFallback);

  log.debug({ from: msg.from, remote: msg.id?.remote }, 'Mensagem WhatsApp sem telefone resolvido');
  return null;
}

function shouldIgnore(msg: Message): boolean {
  if (msg.fromMe) return true;
  if (!msg.from || msg.from === 'status@broadcast') return true;
  return false;
}

function isGroupChatId(id: string | undefined): boolean {
  return Boolean(id?.endsWith('@g.us'));
}

async function resolveGroupMessageAuthor(msg: Message): Promise<{
  authorId: string;
  authorName: string | null;
  authorPhone: string | null;
}> {
  const fallbackId = msg.author ?? msg.from ?? 'unknown';
  let authorName: string | null = null;
  let authorPhone: string | null = null;

  try {
    const contact = await msg.getContact();
    authorName = contact.pushname ?? contact.name ?? contact.shortName ?? null;
    const phone = contact.number?.replace(/\D/g, '');
    if (phone) authorPhone = `+${phone}`;
  } catch (err) {
    log.debug({ err }, 'Falha ao resolver autor da mensagem de grupo');
  }

  if (!authorPhone) {
    const authorDigits = msg.author?.replace(/\D/g, '');
    if (authorDigits) authorPhone = `+${authorDigits}`;
  }

  return {
    authorId: fallbackId,
    authorName,
    authorPhone
  };
}

async function downloadGroupAudio(msg: Message): Promise<{ buffer: Buffer; mimeType: string; filename: string } | null> {
  if (!msg.hasMedia) return null;
  try {
    const media = await msg.downloadMedia();
    if (!media?.data) return null;
    const buffer = Buffer.from(media.data, 'base64');
    return {
      buffer,
      mimeType: media.mimetype ?? 'audio/ogg; codecs=opus',
      filename: ((media as unknown as { filename?: string }).filename ?? 'audio.ogg').toLowerCase()
    };
  } catch (err) {
    log.warn({ err }, 'Falha ao baixar midia de mensagem de grupo');
    return null;
  }
}

async function downloadGroupImage(msg: Message): Promise<{ buffer: Buffer; mimeType: string; filename: string } | null> {
  if (!msg.hasMedia) return null;
  try {
    const media = await msg.downloadMedia();
    if (!media?.data) return null;
    const buffer = Buffer.from(media.data, 'base64');
    return {
      buffer,
      mimeType: media.mimetype ?? 'image/jpeg',
      filename: ((media as unknown as { filename?: string }).filename ?? 'image.jpg').toLowerCase()
    };
  } catch (err) {
    log.warn({ err }, 'Falha ao baixar imagem de mensagem de grupo');
    return null;
  }
}

async function extractCsv(msg: Message): Promise<string | null> {
  if (msg.body?.trim() && looksLikeCsv(msg.body)) return msg.body.trim();
  if (!msg.hasMedia) return null;

  const media = await msg.downloadMedia();
  if (!media?.data) return null;

  const filename = ((media as unknown as { filename?: string }).filename ?? '').toLowerCase();
  const mimetype = media.mimetype.toLowerCase();
  const isCsvLike = filename.endsWith('.csv') || mimetype.includes('csv') || mimetype.includes('text/plain') || mimetype.includes('application/octet-stream');
  if (!isCsvLike) return null;

  const text = Buffer.from(media.data, 'base64').toString('utf8').trim();
  return looksLikeCsv(text) ? text : null;
}

async function acknowledgeAdminCsv(phone: string, result: CsvIngestSummary): Promise<void> {
  const failedLine = result.failed ? `\nFalhas: ${result.failed}` : '';
  await client?.sendMessage(
    toChatId(phone),
    `CSV recebido.\nLeads: ${result.received}\nEm processamento: ${result.processing}\nQuarentena: ${result.quarantine}${failedLine}`,
    { sendSeen: false }
  );
}

async function acknowledgeAdminCsvError(phone: string, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : 'erro desconhecido';
  await client?.sendMessage(
    toChatId(phone),
    `CSV nao importado.\nMotivo: ${message}\nCorrija o arquivo e envie novamente.`,
    { sendSeen: false }
  );
}

async function getPdfMediaFromMsg(msg: Message): Promise<{ data: string; mimetype: string } | null> {
  if (msg.hasMedia && msg.type === 'document') {
    try {
      const media = await msg.downloadMedia();
      if (media?.data && media.mimetype === 'application/pdf') {
        return media;
      }
    } catch (err) {
      log.warn({ err }, 'Erro ao baixar mídia do PDF');
    }
  }

  if (msg.hasQuotedMsg) {
    try {
      const quotedMsg = await msg.getQuotedMessage();
      if (quotedMsg && quotedMsg.hasMedia && quotedMsg.type === 'document') {
        const media = await quotedMsg.downloadMedia();
        if (media?.data && media.mimetype === 'application/pdf') {
          return media;
        }
      }
    } catch (err) {
      log.warn({ err }, 'Erro ao buscar mensagem citada para obter PDF');
    }
  }

  return null;
}

async function handleIncoming(msg: Message, handlers: WhatsAppHandlers): Promise<void> {
  if (shouldIgnore(msg)) return;

  const messageId = msg.id?._serialized ?? `${msg.from}:${msg.timestamp}:${msg.body}`;
  if (!markProcessed(messageId)) return;

  const bodyText = (msg.body ?? '').trim();
  if (bodyText.toLowerCase().includes('!vaga')) {
    log.info({ from: msg.from, bodyText }, 'Comando !vaga detectado no modo RH');
    const pdfMedia = await getPdfMediaFromMsg(msg);
    if (pdfMedia) {
      try {
        await client?.sendMessage(
          msg.from,
          '📄 *Recebi seu currículo!* Estou iniciando a triagem e buscando vagas compatíveis na nossa base de dados. Isso levará cerca de 10 a 20 segundos...',
          { quotedMessageId: msg.id?._serialized ?? undefined }
        );
        const buffer = Buffer.from(pdfMedia.data, 'base64');
        const analysis = await analyzeCvAndMatchJobs(buffer);
        await client?.sendMessage(
          msg.from,
          analysis,
          { quotedMessageId: msg.id?._serialized ?? undefined }
        );
      } catch (err) {
        log.error({ err, from: msg.from }, 'Erro ao processar currículo no modo RH');
        await client?.sendMessage(
          msg.from,
          '⚠️ *Erro no processamento:* Não conseguimos realizar a triagem do seu currículo. Certifique-se de que o PDF é válido e tente novamente.',
          { quotedMessageId: msg.id?._serialized ?? undefined }
        );
      }
    } else {
      await client?.sendMessage(
        msg.from,
        '💡 *Como usar o Modo RH:*\n\n1. Envie seu currículo no formato *PDF*.\n2. Escreva *!vaga* na legenda do arquivo.\n\n_Dica: Você também pode responder/marcar um PDF enviado anteriormente digitando apenas a palavra *!vaga*._',
        { quotedMessageId: msg.id?._serialized ?? undefined }
      );
    }
    return;
  }

  if (isGroupChatId(msg.from)) {
    if (!handlers.onGroupInbound) return;
    let media = null;
    let targetMsgForMedia: Message = msg;

    if (!msg.hasMedia && msg.hasQuotedMsg) {
      try {
        const quotedMsg = await msg.getQuotedMessage();
        if (quotedMsg && quotedMsg.hasMedia) {
          targetMsgForMedia = quotedMsg;
        }
      } catch (err) {
        log.warn({ err }, 'Falha ao buscar mensagem citada para extrair midia');
      }
    }

    if (targetMsgForMedia.hasMedia) {
      const isAudio = targetMsgForMedia.type === 'ptt' || targetMsgForMedia.type === 'audio';
      const isImage = targetMsgForMedia.type === 'image';
      if (isAudio) {
        media = await downloadGroupAudio(targetMsgForMedia);
      } else if (isImage) {
        media = await downloadGroupImage(targetMsgForMedia);
      }
    }
    const author = await resolveGroupMessageAuthor(msg);
    const body = (msg.body ?? '').trim();
    if (!body && !media) return;
    const botUser = client?.info
      ? (client.info.wid?.user || client.info.me?.user || (client.info as any).phone || (client.info as any).id?.user)
      : null;
    const isMentionedByMetadata = msg.mentionedIds && botUser
      ? msg.mentionedIds.some((id) => id.includes(botUser))
      : false;
    const isMentionedByTextNumber = botUser ? body.toLowerCase().includes(`@${botUser}`) : false;
    const isBotMentioned = isMentionedByMetadata || isMentionedByTextNumber;

    log.info(
      { groupId: msg.from, author: author.authorId, body, isBotMentioned, botUser },
      'Mensagem de grupo recebida'
    );

    await handlers.onGroupInbound({
      groupId: msg.from as string,
      authorId: author.authorId,
      authorName: author.authorName,
      authorPhone: author.authorPhone,
      body,
      type: msg.type ?? 'chat',
      hasMedia: Boolean(media),
      mediaBuffer: media?.buffer ?? null,
      mediaMimeType: media?.mimeType ?? null,
      mediaFilename: media?.filename ?? null,
      whatsappId: msg.id?._serialized ?? null,
      timestamp: typeof msg.timestamp === 'number' ? msg.timestamp * 1000 : Date.now(),
      isBotMentioned
    });
    return;
  }

  const phone = await resolveInboundPhone(msg);
  if (!phone) return;

  const csv = await extractCsv(msg);

  if (samePhone(phone, env.OPERATOR_PHONE)) {
    if (csv) {
      try {
        const result = await handlers.onAdminCsv(csv);
        await acknowledgeAdminCsv(phone, result);
      } catch (err) {
        log.error({ err }, 'CSV enviado pelo operador nao foi importado');
        await acknowledgeAdminCsvError(phone, err);
      }
      return;
    }
    log.debug({ phone }, 'Mensagem do operador ignorada porque nao contem CSV');
    return;
  }

  if (csv) {
    log.warn(
      { phone, operatorPhone: env.OPERATOR_PHONE, from: msg.from, remote: msg.id?.remote },
      'CSV recebido de remetente nao autorizado'
    );
    return;
  }

  if (!msg.body?.trim()) return;
  await handlers.onInbound({
    phone,
    body: msg.body.trim(),
    whatsappId: msg.id?._serialized ?? null,
    pushName: null
  });
}

function clearReconnectTimer(): void {
  if (!reconnectTimer) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect(handlers: WhatsAppHandlers, reason: string): void {
  if (stopping) return;
  if (reconnectTimer || restartPromise) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    restartWhatsAppQr(handlers, reason).catch((err) => {
      log.error({ err, reason }, 'Falha ao reiniciar WhatsApp QR');
      scheduleReconnect(handlers, reason);
    });
  }, RECONNECT_DELAY_MS);

  log.warn({ reason, reconnectInMs: RECONNECT_DELAY_MS }, 'WhatsApp sera reiniciado automaticamente');
}

async function restartWhatsAppQr(handlers: WhatsAppHandlers, reason: string): Promise<void> {
  if (restartPromise) return restartPromise;

  restartPromise = (async () => {
    ready = false;
    startPromise = null;

    const currentClient = client;
    client = null;

    if (currentClient) {
      try {
        await currentClient.destroy();
      } catch (err) {
        log.warn({ err, reason }, 'Falha ao destruir cliente WhatsApp antes de reconectar');
      }
    }

    await startWhatsAppQr(handlers);
  })().finally(() => {
    restartPromise = null;
  });

  return restartPromise;
}

export async function startWhatsAppQr(handlers: WhatsAppHandlers): Promise<void> {
  if (startPromise) return startPromise;

  startPromise = (async () => {
    stopping = false;
    clearReconnectTimer();

    const authDir = path.resolve(process.cwd(), env.WHATSAPP_AUTH_DIR);
    client = new Client({
      authStrategy: new LocalAuth({ dataPath: authDir }),
      puppeteer: {
        headless: env.WHATSAPP_HEADLESS,
        defaultViewport: null,
        args: [
          ...(IS_LINUX ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] : []),
          '--disable-gpu',
          '--no-first-run',
          '--no-default-browser-check',
          `--user-agent=${USER_AGENT}`
        ]
      },
      webVersionCache: { type: 'none' },
      userAgent: USER_AGENT
    });

    client.on('qr', (qr) => {
      log.info('Escaneie o QR Code abaixo com o WhatsApp');
      qrcode.generate(qr, { small: true });
    });

    client.on('authenticated', () => {
      log.info('WhatsApp autenticado');
    });

    client.on('ready', () => {
      ready = true;
      clearReconnectTimer();
      log.info('WhatsApp conectado por QR e aguardando mensagens');
    });

    client.on('auth_failure', (message) => {
      ready = false;
      log.error({ message }, 'Falha na autenticacao do WhatsApp');
      scheduleReconnect(handlers, 'auth_failure');
    });

    client.on('disconnected', (reason) => {
      ready = false;
      log.warn({ reason }, 'WhatsApp desconectado');
      scheduleReconnect(handlers, String(reason));
    });

    client.on('message', (msg) => {
      handleIncoming(msg, handlers).catch((err) => {
        log.error({ err }, 'Erro ao processar mensagem WhatsApp');
      });
    });

    client.on('message_create', (msg) => {
      handleIncoming(msg, handlers).catch((err) => {
        log.error({ err }, 'Erro ao processar message_create WhatsApp');
      });
    });

    void client.initialize().catch((err) => {
      ready = false;
      startPromise = null;
      log.error({ err }, 'Falha ao inicializar WhatsApp QR');
      scheduleReconnect(handlers, 'initialize_failed');
    });

    startHealthCheck();
  })();

  return startPromise;
}

export async function sendWhatsAppText(phone: string, text: string): Promise<string | null> {
  const chatId = await resolveSendChatId(phone);
  const activeClient = client;
  if (!activeClient || !ready) {
    throw new WhatsAppDeliveryError('not_ready', phone, 'WhatsApp deixou de estar pronto antes do envio');
  }

  try {
    const sent = await activeClient.sendMessage(chatId, text, { sendSeen: false });
    log.info({ phone, whatsappId: sent.id?._serialized }, 'Mensagem enviada via WhatsApp QR');
    return sent.id?._serialized ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('No LID for user')) {
      throw new WhatsAppDeliveryError('number_not_registered', phone, 'Numero sem LID resolvivel no WhatsApp');
    }
    throw new WhatsAppDeliveryError('send_failed', phone, message);
  }
}

export async function sendWhatsAppGroupText(groupId: string, text: string): Promise<string | null> {
  if (!client || !ready) {
    throw new WhatsAppDeliveryError('not_ready', groupId, 'WhatsApp ainda nao esta pronto para envio');
  }
  if (!isGroupChatId(groupId)) {
    throw new WhatsAppDeliveryError('send_failed', groupId, 'ChatId nao eh de grupo (@g.us)');
  }
  try {
    const sent = await client.sendMessage(groupId, text, { sendSeen: false });
    log.info({ groupId, whatsappId: sent.id?._serialized }, 'Mensagem enviada para grupo via WhatsApp QR');
    return sent.id?._serialized ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new WhatsAppDeliveryError('send_failed', groupId, message);
  }
}

export async function sendWhatsAppGroupImage(groupId: string, base64Data: string, caption?: string): Promise<string | null> {
  if (!client || !ready) {
    throw new WhatsAppDeliveryError('not_ready', groupId, 'WhatsApp ainda nao esta pronto para envio');
  }
  if (!isGroupChatId(groupId)) {
    throw new WhatsAppDeliveryError('send_failed', groupId, 'ChatId nao eh de grupo (@g.us)');
  }
  try {
    const media = new whatsappWeb.MessageMedia('image/jpeg', base64Data, 'imagem.jpg');
    const options: whatsappWeb.MessageSendOptions = { sendSeen: false };
    if (caption) options.caption = caption;
    const sent = await client.sendMessage(groupId, media, options);
    log.info({ groupId, whatsappId: sent.id?._serialized }, 'Imagem enviada para grupo via WhatsApp QR');
    return sent.id?._serialized ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new WhatsAppDeliveryError('send_failed', groupId, message);
  }
}

export async function getGroupMetadata(groupId: string): Promise<{ name: string } | null> {
  if (!client || !ready) {
    log.warn('Tentativa de obter metadados do grupo sem o cliente WhatsApp estar pronto');
    return null;
  }
  try {
    const chat = await client.getChatById(groupId);
    if (chat.isGroup) {
      return {
        name: chat.name
      };
    }
  } catch (err) {
    log.debug({ err, groupId }, 'Falha ao buscar metadados do grupo via WhatsApp Client');
  }
  return null;
}

export function isGroupMessageAllowed(chatId: string | undefined): boolean {
  return isGroupChatId(chatId);
}

export async function stopWhatsAppQr(): Promise<void> {
  stopping = true;
  ready = false;
  clearReconnectTimer();
  stopHealthCheck();
  if (!client) return;
  await client.destroy();
  client = null;
  startPromise = null;
}
