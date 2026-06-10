import { describe, expect, it } from 'vitest';
import { buildLeadHandoffReply, buildOperatorHandoffNotification, shouldHandoffToHuman } from '../handoff.js';

describe('Conversation handoff', () => {
  it('detecta pedido direto de ligacao', () => {
    expect(shouldHandoffToHuman('Quando seria nossa ligacao?', [])).toBe(true);
  });

  it('detecta aceite depois de proposta de reuniao', () => {
    const history = [{ role: 'agent', body: 'Faz sentido marcarmos 10 minutos?' }];
    expect(shouldHandoffToHuman('Pode ser', history)).toBe(true);
  });

  it('nao trata aceite generico como handoff sem proximo passo anterior', () => {
    const history = [{ role: 'agent', body: 'Voce acredita que isso reduziria o trabalho do time?' }];
    expect(shouldHandoffToHuman('Claro', history)).toBe(false);
  });

  it('nao trata pergunta sobre ligacao como aceite de agenda', () => {
    expect(shouldHandoffToHuman('Mas voce que vai me ligar?', [])).toBe(false);
  });

  it('gera resposta final de handoff para o lead', () => {
    expect(buildLeadHandoffReply()).toContain('analista da Aithos');
  });

  it('monta notificacao com contexto para o operador', () => {
    const notification = buildOperatorHandoffNotification({
      lead: {
        companyName: 'Empresa Teste',
        contactName: 'Joao',
        phone: '+5511999999999',
        leadScore: 85,
        segment: 'saude'
      },
      reason: 'lead pediu reuniao/proposta',
      lastInbound: 'Quando seria nossa ligacao?',
      history: [
        { role: 'agent', body: 'Faz sentido marcarmos 10 minutos?' },
        { role: 'lead', body: 'Quando seria nossa ligacao?' }
      ]
    });

    expect(notification).toContain('Empresa: Empresa Teste');
    expect(notification).toContain('Telefone: +5511999999999');
    expect(notification).toContain('Historico recente:');
  });
});
