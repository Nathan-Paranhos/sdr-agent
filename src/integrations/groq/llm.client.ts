import Groq from 'groq-sdk';
import { env } from '../../config/env.js';
import { log } from '../../config/logger.js';

interface GroqClientSlot {
  client: Groq;
  apiKey: string;
  keyLabel: string;
  rateLimitedUntil: number;
}

function configuredApiKeys(): string[] {
  const keys = [env.GROQ_API_KEY, ...(env.GROQ_API_KEYS?.split(',') ?? [])]
    .map((key) => key?.trim())
    .filter((key): key is string => Boolean(key));

  return [...new Set(keys)];
}

const groqClients: GroqClientSlot[] = configuredApiKeys().map((apiKey, index) => ({
  client: new Groq({ apiKey }),
  apiKey,
  keyLabel: `groq_key_${index + 1}`,
  rateLimitedUntil: 0
}));

export function getNextGroqKey(): { key: string; label: string } | null {
  try {
    const slot = pickGroqClient();
    return { key: slot.apiKey, label: slot.keyLabel };
  } catch {
    return null;
  }
}

let nextGroqClientIndex = 0;
let llmQueueTail: Promise<void> = Promise.resolve();

export interface LLMCallOptions {
  systemPrompt: string;
  userContent: string;
  expectJson?: boolean;
  temperature?: number;
  maxTokens?: number;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface LLMResult {
  text: string;
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number };
  durationMs: number;
}

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export async function callLLM(opts: LLMCallOptions): Promise<LLMResult> {
  return enqueueLLMCall(() => executeLLMCall(opts));
}

async function executeLLMCall(opts: LLMCallOptions): Promise<LLMResult> {
  const start = Date.now();
  const messages: ChatMessage[] = [
    { role: 'system', content: opts.systemPrompt },
    ...(opts.conversationHistory ?? []),
    { role: 'user', content: opts.userContent }
  ];

  const attempts = [
    { model: env.GROQ_MODEL_PRIMARY, temperature: opts.temperature ?? env.GROQ_TEMPERATURE },
    { model: env.GROQ_MODEL_FALLBACK, temperature: 0.1 },
    { model: env.GROQ_MODEL_PRIMARY, temperature: 0.1 }
  ].filter((attempt, index, list) => index === list.findIndex((item) => item.model === attempt.model && item.temperature === attempt.temperature));

  let lastError: unknown;

  for (let round = 1; round <= env.GROQ_RETRY_ROUNDS; round++) {
    for (const [attemptIndex, attempt] of attempts.entries()) {
      for (let keyAttempt = 0; keyAttempt < groqClients.length; keyAttempt++) {
        const cooldownMs = delayUntilAnyClientAvailable();
        if (cooldownMs > 0) {
          log.warn({ operation: 'llm_wait_rate_limit', cooldownMs }, 'Aguardando janela de limite Groq');
          await sleep(cooldownMs);
        }

        const groq = pickGroqClient();

        try {
          const response = await groq.client.chat.completions.create({
            model: attempt.model,
            messages,
            temperature: attempt.temperature,
            max_tokens: opts.maxTokens ?? env.GROQ_MAX_TOKENS,
            ...(opts.expectJson ? { response_format: { type: 'json_object' as const } } : {})
          });

          const text = response.choices[0]?.message?.content ?? '';
          const durationMs = Date.now() - start;

          log.info({
            operation: 'llm_call',
            model: attempt.model,
            keyLabel: groq.keyLabel,
            durationMs,
            promptTokens: response.usage?.prompt_tokens,
            completionTokens: response.usage?.completion_tokens
          });

          return {
            text,
            model: attempt.model,
            usage: {
              prompt_tokens: response.usage?.prompt_tokens ?? 0,
              completion_tokens: response.usage?.completion_tokens ?? 0
            },
            durationMs
          };
        } catch (err: unknown) {
          lastError = err;
          const status = errorStatus(err);
          const isRateLimit = status === 429;
          const retryMs = isRateLimit ? retryDelayMs(err) : retryBackoffMs(round, keyAttempt);
          const retryable = isRetryableStatus(status);

          if (isRateLimit) {
            groq.rateLimitedUntil = Math.max(groq.rateLimitedUntil, Date.now() + retryMs);
          }

          log.warn(
            {
              operation: 'llm_retry',
              model: attempt.model,
              keyLabel: groq.keyLabel,
              round,
              totalRounds: env.GROQ_RETRY_ROUNDS,
              keyAttempt: keyAttempt + 1,
              totalKeys: groqClients.length,
              status,
              isRateLimit,
              retryable,
              retryMs,
              err: summarizeError(err)
            },
            'Falha em chamada Groq'
          );

          const finalAttempt =
            round === env.GROQ_RETRY_ROUNDS && attemptIndex === attempts.length - 1 && keyAttempt === groqClients.length - 1;
          if (finalAttempt) break;

          const waitMs = isRateLimit ? delayUntilAnyClientAvailable() : retryable ? retryMs : 0;
          if (waitMs > 0) await sleep(waitMs);
        }
      }
    }
  }

  throw new LLMUnavailableError('Todos os modelos Groq falharam', { cause: lastError });
}

export function parseJsonResponse<T>(text: string): T {
  const clean = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  return JSON.parse(clean) as T;
}

export class LLMUnavailableError extends Error {}

function pickGroqClient(): GroqClientSlot {
  if (groqClients.length === 0) {
    throw new LLMUnavailableError('Nenhuma chave Groq configurada');
  }

  const now = Date.now();
  for (let offset = 0; offset < groqClients.length; offset++) {
    const slot = groqClients[nextGroqClientIndex % groqClients.length];
    nextGroqClientIndex = (nextGroqClientIndex + 1) % groqClients.length;
    if (slot && slot.rateLimitedUntil <= now) return slot;
  }

  const firstSlot = groqClients[0];
  if (!firstSlot) throw new LLMUnavailableError('Nenhuma chave Groq configurada');

  return groqClients.reduce((soonest, slot) => (slot.rateLimitedUntil < soonest.rateLimitedUntil ? slot : soonest), firstSlot);
}

function enqueueLLMCall<T>(task: () => Promise<T>): Promise<T> {
  const run = llmQueueTail.catch(() => undefined).then(task);
  llmQueueTail = run.then(
    () => sleep(env.GROQ_MIN_DELAY_MS),
    () => sleep(env.GROQ_MIN_DELAY_MS)
  );
  return run;
}

function retryDelayMs(err: unknown): number {
  const retryAfter = parseDelayHeader(readErrorHeader(err, 'retry-after'));
  const tokenReset = parseDelayHeader(readErrorHeader(err, 'x-ratelimit-reset-tokens'));
  return clampRetryDelay((retryAfter ?? tokenReset ?? 5000) + 250);
}

function retryBackoffMs(round: number, keyAttempt: number): number {
  return Math.min(5000, 500 * round + keyAttempt * 250);
}

function delayUntilAnyClientAvailable(): number {
  if (groqClients.length === 0) return 0;

  const now = Date.now();
  if (groqClients.some((slot) => slot.rateLimitedUntil <= now)) return 0;

  const earliest = Math.min(...groqClients.map((slot) => slot.rateLimitedUntil));
  return Math.max(0, earliest - now);
}

function isRetryableStatus(status: number | undefined): boolean {
  return status === undefined || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function errorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('status' in err)) return undefined;

  const status = Number((err as { status?: unknown }).status);
  return Number.isFinite(status) ? status : undefined;
}

function summarizeError(err: unknown): Record<string, unknown> {
  const status = errorStatus(err);
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      status,
      code: readErrorProperty(err, 'code'),
      type: readErrorProperty(err, 'type')
    };
  }

  return { status, message: String(err) };
}

function readErrorProperty(err: Error, property: string): unknown {
  const value = (err as unknown as Record<string, unknown>)[property];
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

function readErrorHeader(err: unknown, name: string): string | undefined {
  if (typeof err !== 'object' || err === null || !('headers' in err)) return undefined;

  const headers = (err as { headers?: unknown }).headers;
  if (!headers) return undefined;

  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get: (key: string) => unknown }).get(name);
    return value === undefined || value === null ? undefined : String(value);
  }

  if (typeof headers === 'object') {
    const record = headers as Record<string, unknown>;
    const value = record[name] ?? record[name.toLowerCase()];
    return value === undefined || value === null ? undefined : String(value);
  }

  return undefined;
}

function parseDelayHeader(value: string | undefined): number | undefined {
  if (!value) return undefined;

  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return seconds * 1000;

  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());

  let durationMs = 0;
  let matched = false;
  for (const match of trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    const amount = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(amount)) continue;

    matched = true;
    if (unit === 'ms') durationMs += amount;
    if (unit === 's') durationMs += amount * 1000;
    if (unit === 'm') durationMs += amount * 60_000;
    if (unit === 'h') durationMs += amount * 60 * 60_000;
  }
  if (matched) return durationMs;

  const secondsMatch = /^(\d+(?:\.\d+)?)s$/.exec(trimmed);
  if (secondsMatch?.[1]) return Number(secondsMatch[1]) * 1000;

  return undefined;
}

function clampRetryDelay(ms: number): number {
  return Math.max(1000, Math.min(ms, 5 * 60_000));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
