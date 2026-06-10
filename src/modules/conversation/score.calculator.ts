import { prisma } from '../../db/client.js';
import { stringifyJson } from '../../db/utils.js';

export const SCORE_EVENTS = {
  FIRST_REPLY: 15,
  REPLY_UNDER_1H: 10,
  INTENT_INTEREST: 30,
  INTENT_TECH_QUESTION: 10,
  INTENT_OPPORTUNITY: 50,
  OBJECTION_RECOVERED: 10,
  COMPANY_MEDIUM_LARGE: 10,
  FORM_COMPLETED: 20,
  INTENT_DISINTEREST: -9999
} as const;

export const MAX_LEAD_SCORE = 100;

export type ScoreEventType = keyof typeof SCORE_EVENTS;

export function applyScoreDelta(currentScore: number, eventType: ScoreEventType): number {
  return Math.min(MAX_LEAD_SCORE, Math.max(0, currentScore + SCORE_EVENTS[eventType]));
}

export async function addScoreEvent(leadId: string, eventType: ScoreEventType, meta?: object): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const lead = await tx.lead.findUnique({
      where: { lead_id: leadId },
      select: { lead_score: true }
    });
    if (!lead) throw new Error(`Lead nao encontrado: ${leadId}`);

    const points = SCORE_EVENTS[eventType];
    const newScore = applyScoreDelta(lead.lead_score, eventType);

    await tx.lead.update({
      where: { lead_id: leadId },
      data: { lead_score: newScore }
    });

    await tx.scoreEvent.create({
      data: {
        lead_id: leadId,
        event_type: eventType,
        points,
        score_after: newScore,
        meta: stringifyJson(meta ?? {})
      }
    });

    return newScore;
  });
}
