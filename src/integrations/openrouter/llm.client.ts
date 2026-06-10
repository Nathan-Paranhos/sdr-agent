import OpenAI from 'openai';
import { env } from '../../config/env.js';
import { log } from '../../config/logger.js';
import { callLLM } from '../groq/llm.client.js';

export class OpenRouterUnavailableError extends Error {}

let openrouterClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (openrouterClient) return openrouterClient;

  if (!env.OPENROUTER_API_KEY?.trim()) {
    throw new OpenRouterUnavailableError('OPENROUTER_API_KEY nao configurada');
  }

  openrouterClient = new OpenAI({
    apiKey: env.OPENROUTER_API_KEY,
    baseURL: env.OPENROUTER_BASE_URL,
    defaultHeaders: {
      'HTTP-Referer': env.OPENROUTER_REFERER,
      'X-Title': env.OPENROUTER_APP_TITLE
    }
  });

  return openrouterClient;
}

export interface OpenRouterChatOptions {
  systemPrompt: string;
  userContent: string | any[];
  temperature?: number;
  maxTokens?: number;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string | any[] }>;
  model?: string;
}

export interface OpenRouterChatResult {
  text: string;
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number };
  durationMs: number;
}

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string | any[] };

function readErrorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('status' in err)) return undefined;
  const status = Number((err as { status?: unknown }).status);
  return Number.isFinite(status) ? status : undefined;
}

function summarize(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      status: readErrorStatus(err)
    };
  }
  return { message: String(err) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(status: number | undefined): boolean {
  return status === undefined || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

export async function callOpenRouterChat(opts: OpenRouterChatOptions): Promise<OpenRouterChatResult> {
  const start = Date.now();
  log.info('Chamada OpenRouter interceptada. Redirecionando para Groq como LLM primaria para evitar Rate Limit/404...');
  
  try {
    let userContentString = '';
    if (typeof opts.userContent === 'string') {
      userContentString = opts.userContent;
    } else if (Array.isArray(opts.userContent)) {
      const textItem = opts.userContent.find((item) => item.type === 'text');
      userContentString = textItem?.text ?? '';
    }

    const mappedHistory = opts.conversationHistory?.map((h) => {
      let contentStr = '';
      if (typeof h.content === 'string') {
        contentStr = h.content;
      } else if (Array.isArray(h.content)) {
        const textItem = h.content.find((item) => item.type === 'text');
        contentStr = textItem?.text ?? '';
      }
      return { role: h.role, content: contentStr };
    });

    const groqRes = await callLLM({
      systemPrompt: opts.systemPrompt,
      userContent: userContentString,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      ...(mappedHistory !== undefined ? { conversationHistory: mappedHistory } : {})
    });
    
    return {
      text: groqRes.text,
      model: `groq/${groqRes.model}`,
      usage: groqRes.usage,
      durationMs: Date.now() - start
    };
  } catch (groqErr) {
    log.error({ err: groqErr }, 'Falha na chamada Groq');
    throw new OpenRouterUnavailableError('Falha ao usar Groq como LLM primaria', { cause: groqErr });
  }
}
