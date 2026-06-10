import { describe, expect, it } from 'vitest';

process.env.GROUP_MANAGER_ENABLED = 'true';
process.env.GROUP_MANAGER_TARGET_GROUP_ID = '120363012345678901@g.us';
process.env.GROUP_MANAGER_BOT_MENTION = '@Gerente';
process.env.GROUP_MANAGER_COMMANDS = '!resumo,!pendencias';
process.env.OPENROUTER_API_KEY = 'sk-or-test';
process.env.GROQ_API_KEY = 'gsk-test';

const { detectGroupTrigger, buildHistoryLine, isTestCommand, checkProactiveResponseTrigger } = await import('../group-manager.service.js');
const { buildAnalystUserContent, buildNewsUserContent, MEMBER_INTERACTION_SYSTEM_PROMPT, MEMBER_EVALUATION_SYSTEM_PROMPT } = await import('../group-manager.prompt.js');

describe('Group Manager service - trigger detection', () => {
  it('detecta comando !resumo como trigger', () => {
    const result = detectGroupTrigger('!resumo do dia por favor');
    expect(result.triggered).toBe(true);
    expect(result.command).toBe('!resumo');
  });

  it('detecta mencao @Gerente como trigger', () => {
    const result = detectGroupTrigger('oi @Gerente, da um help ai');
    expect(result.triggered).toBe(true);
    expect(result.mentionOnly).toBe(true);
  });

  it('detecta mencoes alternativas como @genisis, @Aithos Tech, @aithostech, @ genisis', () => {
    expect(detectGroupTrigger('oi @genisis, blz?').triggered).toBe(true);
    expect(detectGroupTrigger('fala com o @Aithos Tech').triggered).toBe(true);
    expect(detectGroupTrigger('marca o @aithostech aqui').triggered).toBe(true);
    expect(detectGroupTrigger('alguem chama o @ genisis por favor').triggered).toBe(true);
  });

  it('nao dispara em mensagens sem comando nem mencao', () => {
    const result = detectGroupTrigger('bom dia time, tudo certo?');
    expect(result.triggered).toBe(false);
  });

  it('ignora mencao parcial (substring dentro de palavra)', () => {
    const result = detectGroupTrigger('esse @Gerentão nao para');
    expect(result.triggered).toBe(false);
  });
});

describe('Group Manager service - test command detection', () => {
  it('detecta !teste como comando de teste', () => {
    expect(isTestCommand('!teste')).toBe(true);
    expect(isTestCommand('!test')).toBe(true);
    expect(isTestCommand('algo !teste de novo')).toBe(true);
  });

  it('detecta mencao ao bot com palavra teste/test/ping/status/ativo', () => {
    expect(isTestCommand('oi @Gerente teste')).toBe(true);
    expect(isTestCommand('olha @Gerente ping')).toBe(true);
    expect(isTestCommand('e ai @Gerente status')).toBe(true);
    expect(isTestCommand('o @Gerente ta ativo?')).toBe(true);
  });

  it('ignora mencao sem palavra-chave ou com outras palavras', () => {
    expect(isTestCommand('oi @Gerente tudo bem?')).toBe(false);
    expect(isTestCommand('bom dia @Gerente')).toBe(false);
  });
});

describe('Group Manager service - history formatting', () => {
  it('marca mensagens de audio com prefixo de transcricao', () => {
    const line = buildHistoryLine({
      author: 'Joao',
      body: 'preciso decidir sobre o deploy',
      media_type: 'audio',
      created_at: new Date('2026-06-06T10:00:00Z')
    });
    expect(line).toContain('[AUDIO TRANSCRITO]');
    expect(line).toContain('Joao');
  });

  it('mantem formatacao de texto normal', () => {
    const line = buildHistoryLine({
      author: 'Maria',
      body: 'top, fechado',
      media_type: 'text',
      created_at: new Date('2026-06-06T10:00:00Z')
    });
    expect(line).not.toContain('[AUDIO TRANSCRITO]');
    expect(line).toContain('Maria');
  });
});

describe('Group Manager service - prompt building', () => {
  it('monta o contexto do analista com historico', () => {
    const out = buildAnalystUserContent({
      historyLines: ['[Joao - 10:00]: oi'],
      triggeredBy: 'Joao'
    });
    expect(out).toContain('Joao');
    expect(out).toContain('oi');
  });

  it('cai em fallback quando o historico esta vazio', () => {
    const out = buildAnalystUserContent({ historyLines: [], triggeredBy: 'Maria' });
    expect(out).toContain('nenhuma mensagem registrada');
  });

  it('monta o contexto do curador de noticias com fallback', () => {
    expect(buildNewsUserContent('')).toContain('nenhuma noticia foi coletada');
    expect(buildNewsUserContent('1. Titulo X')).toContain('Titulo X');
  });
});

describe('Group Manager service - new features', () => {
  it('contem prompts de avaliacao e interacao com referencia a Aithos Tech', () => {
    expect(MEMBER_INTERACTION_SYSTEM_PROMPT).toContain('Aithos Tech');
    expect(MEMBER_INTERACTION_SYSTEM_PROMPT).toContain('aithostech.com.br');
    expect(MEMBER_EVALUATION_SYSTEM_PROMPT).toContain('Aithos Tech');
    expect(MEMBER_EVALUATION_SYSTEM_PROMPT).toContain('aithostech.com.br');
  });
});

describe('Hermes proactive response trigger', () => {
  it('dispara para perguntas tecnicas com "?" contendo palavras-chave', () => {
    process.env.HERMES_PROACTIVE_ENABLED = 'true';
    process.env.HERMES_COOLDOWN_SEC = '0';

    const result = checkProactiveResponseTrigger('como configurar o deploy da aws?');
    expect(result).toBe(true);
  });

  it('nao dispara se nao contiver palavras-chave tecnicas', () => {
    const result = checkProactiveResponseTrigger('como vai voce?');
    expect(result).toBe(false);
  });
});
