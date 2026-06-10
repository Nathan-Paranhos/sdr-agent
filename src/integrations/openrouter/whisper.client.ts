import { env } from '../../config/env.js';
import { log } from '../../config/logger.js';

export class OpenRouterWhisperError extends Error {}

export interface TranscribeAudioOptions {
  audio: Buffer;
  filename?: string;
  mimeType?: string;
  language?: string;
}

export interface TranscribeAudioResult {
  text: string;
  model: string;
  durationMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readErrorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('status' in err)) return undefined;
  const status = Number((err as { status?: unknown }).status);
  return Number.isFinite(status) ? status : undefined;
}

function isRetryable(status: number | undefined): boolean {
  return status === undefined || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function getFormatFromFilename(filename?: string, mimeType?: string): string {
  if (filename) {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (ext && ['ogg', 'mp3', 'wav', 'm4a', 'webm'].includes(ext)) {
      return ext;
    }
  }
  if (mimeType) {
    if (mimeType.includes('ogg')) return 'ogg';
    if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3';
    if (mimeType.includes('wav')) return 'wav';
    if (mimeType.includes('m4a')) return 'm4a';
    if (mimeType.includes('webm')) return 'webm';
  }
  return 'ogg';
}

export async function transcribeAudio(opts: TranscribeAudioOptions): Promise<TranscribeAudioResult> {
  // Alterado para usar a API da Groq para Whisper para evitar erro 402 do OpenRouter
  const { getNextGroqKey } = await import('../groq/llm.client.js');
  const groqKeyInfo = getNextGroqKey();
  if (!groqKeyInfo) {
    throw new OpenRouterWhisperError('Nenhuma chave GROQ disponivel para transcricao Whisper');
  }

  const start = Date.now();
  let lastError: unknown;
  const rounds = 2;
  
  const ext = getFormatFromFilename(opts.filename, opts.mimeType);
  const blob = new Blob([new Uint8Array(opts.audio)], { type: opts.mimeType || `audio/${ext}` });
  
  for (let round = 1; round <= rounds; round++) {
    try {
      const formData = new FormData();
      formData.append('file', blob, opts.filename || `audio.${ext}`);
      formData.append('model', 'whisper-large-v3-turbo');
      formData.append('response_format', 'json');
      if (opts.language) formData.append('language', opts.language);

      const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${groqKeyInfo.key}`
        },
        body: formData
      });

      if (!response.ok) {
        const errorText = await response.text();
        const errObj = new Error(`${response.status} ${errorText}`) as any;
        errObj.status = response.status;
        throw errObj;
      }

      const data = (await response.json()) as { text?: string };
      const text = data.text?.trim() ?? '';
      const durationMs = Date.now() - start;

      log.info(
        {
          operation: 'groq_whisper',
          model: 'whisper-large-v3-turbo',
          keyLabel: groqKeyInfo.label,
          durationMs,
          textLength: text.length
        },
        'Audio transcrito via Groq Whisper'
      );

      return {
        text,
        model: 'groq/whisper-large-v3-turbo',
        durationMs
      };
    } catch (err) {
      lastError = err;
      const status = readErrorStatus(err);
      const retryable = isRetryable(status);

      log.warn(
        {
          operation: 'groq_whisper_retry',
          model: 'whisper-large-v3-turbo',
          round,
          totalRounds: rounds,
          status,
          retryable,
          err: err instanceof Error ? { name: err.name, message: err.message } : { message: String(err) }
        },
        'Falha em transcricao Groq Whisper'
      );

      if (!retryable || round === rounds) break;
      await sleep(Math.min(3000, 500 * round));
    }
  }

  throw new OpenRouterWhisperError('Todas as tentativas de transcricao Groq Whisper falharam', { cause: lastError });
}
