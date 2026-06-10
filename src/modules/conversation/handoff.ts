export interface ConversationLine {
  role: string;
  body: string;
}

export interface HandoffLeadInfo {
  companyName: string;
  contactName: string | null;
  phone: string;
  leadScore: number;
  segment: string | null;
}

function normalizeForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[?!.,;:()[\]{}"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getPreviousAgentMessage(history: ConversationLine[]): string {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const row = history[i];
    if (row?.role === 'agent') return normalizeForMatch(row.body);
  }
  return '';
}

function previousAgentAskedForNextStep(history: ConversationLine[]): boolean {
  const previousAgent = getPreviousAgentMessage(history);
  if (!previousAgent) return false;

  const nextStepSignals = [
    'marcarmos',
    'marcar',
    'agendar',
    'agenda',
    'ligacao',
    'reuniao',
    '10 minutos',
    'te chamar',
    'posso te chamar',
    'especialista',
    'analista',
    'consultor'
  ];

  return nextStepSignals.some((signal) => previousAgent.includes(signal));
}

function isAffirmativeAcceptance(text: string): boolean {
  const normalized = normalizeForMatch(text);
  const shortAcceptances = new Set([
    'sim',
    'claro',
    'pode',
    'pode ser',
    'ok',
    'okay',
    'ta bom',
    'tudo bem',
    'fechado',
    'perfeito',
    'beleza',
    'bora',
    'vamos',
    'faz sentido',
    'quero',
    'manda'
  ]);

  if (shortAcceptances.has(normalized)) return true;
  return /^(sim|claro|pode|ok|fechado|perfeito|beleza|bora|vamos)\b/.test(normalized);
}

export function shouldHandoffToHuman(body: string, history: ConversationLine[]): boolean {
  const text = normalizeForMatch(body);

  const directSignals = [
    'quando seria nossa ligacao',
    'quando seria a ligacao',
    'quando seria nossa reuniao',
    'quando podemos falar',
    'quando vamos falar',
    'quando voce pode ligar',
    'qual horario',
    'que horario',
    'manda os horarios',
    'me passa horarios',
    'vamos marcar',
    'bora marcar',
    'podemos marcar',
    'pode marcar',
    'quero marcar',
    'quero agendar',
    'pode agendar',
    'vamos agendar',
    'agenda comigo',
    'marcar uma call',
    'marcar uma ligacao',
    'marcar uma reuniao',
    'pode me ligar',
    'quero falar com um analista',
    'quero falar com analista',
    'quero falar com consultor',
    'quero falar com especialista',
    'passa para um analista',
    'passa para o analista',
    'passa para um consultor',
    'manda proposta',
    'me manda proposta',
    'quero uma proposta',
    'quero proposta',
    'manda o orcamento',
    'me manda o orcamento',
    'quero orcamento'
  ];

  if (directSignals.some((signal) => text.includes(signal))) return true;
  if (/\b(me liga|me ligue)\b/.test(text)) return true;
  return previousAgentAskedForNextStep(history) && isAffirmativeAcceptance(text);
}

export function buildLeadHandoffReply(): string {
  return 'Perfeito, vou passar seu contato e esse contexto para um analista da Aithos agora. Ele te chama por aqui para combinar o melhor horario.';
}

function limitText(text: string, maxLength: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 3).trimEnd()}...`;
}

function formatHistory(history: ConversationLine[]): string[] {
  return history.slice(-6).map((row) => {
    const label = row.role === 'agent' ? 'Aithos' : 'Lead';
    return `${label}: ${limitText(row.body, 180)}`;
  });
}

export function buildOperatorHandoffNotification(input: {
  lead: HandoffLeadInfo;
  reason: string;
  lastInbound: string;
  history: ConversationLine[];
}): string {
  const lines = [
    'Lead pediu atendimento humano.',
    `Empresa: ${input.lead.companyName}`,
    input.lead.contactName ? `Contato: ${input.lead.contactName}` : null,
    input.lead.segment ? `Segmento: ${input.lead.segment}` : null,
    `Telefone: ${input.lead.phone}`,
    `Score: ${input.lead.leadScore}`,
    `Motivo: ${input.reason}`,
    `Ultima mensagem: ${limitText(input.lastInbound, 220)}`,
    '',
    'Historico recente:',
    ...formatHistory(input.history)
  ];

  return lines.filter((line): line is string => line !== null).join('\n');
}
