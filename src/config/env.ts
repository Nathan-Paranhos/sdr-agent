import { z } from 'zod';

const EnvSchema = z
  .object({
  PORT: z.coerce.number().int().positive().default(3001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().default('file:./sdr-agent.db'),

  GROQ_API_KEY: z.string().optional(),
  GROQ_API_KEYS: z.string().optional(),
  GROQ_MODEL_PRIMARY: z.string().default('llama-3.3-70b-versatile'),
  GROQ_MODEL_FALLBACK: z.string().default('llama-3.1-8b-instant'),
  GROQ_MAX_TOKENS: z.coerce.number().int().positive().default(1024),
  GROQ_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.3),
  GROQ_MIN_DELAY_MS: z.coerce.number().int().nonnegative().default(6500),
  GROQ_RETRY_ROUNDS: z.coerce.number().int().positive().default(2),

  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().default('https://openrouter.ai/api/v1'),
  OPENROUTER_MODEL: z.string().default('meta-llama/llama-3.3-70b-instruct:free'),
  OPENROUTER_FALLBACK_MODEL: z.string().default('meta-llama/llama-3.1-8b-instruct:free'),
  OPENROUTER_WHISPER_MODEL: z.string().default('openai/whisper-large-v3'),
  OPENROUTER_MAX_TOKENS: z.coerce.number().int().positive().default(1500),
  OPENROUTER_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.4),
  OPENROUTER_RETRY_ROUNDS: z.coerce.number().int().positive().default(2),
  OPENROUTER_REFERER: z.string().default('https://paranhos.dev'),
  OPENROUTER_APP_TITLE: z.string().default('SDR Agent Group Manager'),

  WHATSAPP_AUTH_DIR: z.string().default('.wwebjs_auth'),
  WHATSAPP_HEADLESS: z.coerce.boolean().default(true),
  SEND_FIRST_MESSAGE_IMMEDIATELY: z.coerce.boolean().default(true),

  DEFAULT_TENANT_ID: z.string().uuid(),
  DEFAULT_AGENT_NAME: z.string().min(1),
  DEFAULT_SERVICE_CATEGORY: z.string().min(1),

  OPERATOR_PHONE: z.string().min(1),
  OPERATOR_SECRET: z.string().min(1),

  GROUP_MANAGER_ENABLED: z.coerce.boolean().default(false),
  GROUP_MANAGER_TARGET_GROUP_ID: z.string().optional(),
  GROUP_MANAGER_BOT_MENTION: z.string().default('@Genesis'),
  GROUP_MANAGER_COMMANDS: z.string().default('!resumo,!pendencias,!decisoes,!kpis'),
  GROUP_MANAGER_NEWS_CRON: z.string().default('0 9 * * *'),
  GROUP_MANAGER_NEWS_TIMEZONE: z.string().default('America/Sao_Paulo'),
  GROUP_MANAGER_HISTORY_HOURS: z.coerce.number().int().positive().default(24),
  GROUP_MANAGER_HISTORY_LIMIT: z.coerce.number().int().positive().default(100),
  GROUP_MANAGER_TRANSCRIBE_AUDIO: z.coerce.boolean().default(true),
  GROUP_MANAGER_NEWSAPI_KEY: z.string().optional(),
  GROUP_MANAGER_NEWSAPI_COUNTRY: z.string().default('us'),
  GROUP_MANAGER_NEWSAPI_CATEGORY: z.string().default('technology'),
  GROUP_MANAGER_HACKERNEWS_LIMIT: z.coerce.number().int().positive().default(30),
  GROUP_MANAGER_NEWS_TOP_N: z.coerce.number().int().positive().default(3),
  HERMES_PROACTIVE_ENABLED: z.coerce.boolean().default(true),
  HERMES_PROACTIVE_PROBABILITY: z.coerce.number().min(0).max(1).default(0.4),
  HERMES_COOLDOWN_SEC: z.coerce.number().int().nonnegative().default(120),
  ADZUNA_APP_ID: z.string().optional(),
  ADZUNA_APP_KEY: z.string().optional(),
  HF_TOKEN: z.string().optional()
  })
  .superRefine((value, ctx) => {
    const groqKeys = [value.GROQ_API_KEY, ...(value.GROQ_API_KEYS?.split(',') ?? [])]
      .map((key) => key?.trim())
      .filter(Boolean);

    if (groqKeys.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GROQ_API_KEY'],
        message: 'Configure GROQ_API_KEY ou GROQ_API_KEYS (necessario para o SDR Agent)'
      });
    }

    if (value.GROUP_MANAGER_ENABLED) {
      if (!value.OPENROUTER_API_KEY?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['OPENROUTER_API_KEY'],
          message: 'Configure OPENROUTER_API_KEY para usar o Agente Gerente de Grupo'
        });
      }
      if (!value.GROUP_MANAGER_TARGET_GROUP_ID?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['GROUP_MANAGER_TARGET_GROUP_ID'],
          message: 'Configure GROUP_MANAGER_TARGET_GROUP_ID (ex: 120363012345678901@g.us)'
        });
      }
    }
  });

export type Env = z.infer<typeof EnvSchema>;

export const env = EnvSchema.parse(process.env);

export function validateEnv(): Env {
  return env;
}
