import { z } from 'zod';
import { callLLM, parseJsonResponse } from '../../integrations/groq/llm.client.js';

export const IntentSchema = z.enum([
  'INTEREST',
  'TECH_QUESTION',
  'OBJECTION',
  'DISINTEREST',
  'OPPORTUNITY',
  'AMBIGUOUS',
  'HOSTILE'
]);

export type Intent = z.infer<typeof IntentSchema>;

const ClassifierResponseSchema = z.object({
  intent: IntentSchema,
  confidence: z.number().min(0).max(1)
});

export async function classifyIntent(message: string): Promise<{ intent: Intent; confidence: number }> {
  const llm = await callLLM({
    systemPrompt: 'Classifique a intenção da mensagem de um lead B2B. Retorne apenas JSON: {"intent":"...","confidence":0.0}.',
    userContent: message,
    expectJson: true,
    maxTokens: 120,
    temperature: 0.1
  });
  return ClassifierResponseSchema.parse(parseJsonResponse<unknown>(llm.text));
}
