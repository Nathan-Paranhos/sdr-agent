import { prisma } from '../../db/client.js';
import { stringifyJson } from '../../db/utils.js';
import { addScoreEvent } from '../conversation/score.calculator.js';
import { maybeDeliverQualifiedLead } from '../delivery/delivery.service.js';

export async function recordQualificationForm(leadId: string, responses: Record<string, unknown>): Promise<void> {
  await prisma.lead.update({
    where: { lead_id: leadId },
    data: {
      form_responses: stringifyJson(responses),
      form_sent_at: new Date()
    }
  });
  await addScoreEvent(leadId, 'FORM_COMPLETED', responses);
  await maybeDeliverQualifiedLead(leadId);
}

export function renderQualificationForm(leadId: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>Qualificacao</title></head>
<body>
  <h1>Qualificacao do lead</h1>
  <form method="post" action="/qualify/${leadId}">
    <label>Qual o principal objetivo?<br><input name="goal" required></label><br><br>
    <label>Orcamento estimado?<br><input name="budget" required></label><br><br>
    <label>Prazo desejado?<br><input name="deadline" required></label><br><br>
    <button type="submit">Enviar</button>
  </form>
</body>
</html>`;
}
