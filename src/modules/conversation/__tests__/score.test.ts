import { describe, expect, it } from 'vitest';
import { MAX_LEAD_SCORE, applyScoreDelta } from '../score.calculator.js';

describe('Score calculator', () => {
  it('INTENT_OPPORTUNITY dá 50 pontos', () => {
    expect(applyScoreDelta(0, 'INTENT_OPPORTUNITY')).toBe(50);
  });

  it('INTENT_DISINTEREST zera o score', () => {
    expect(applyScoreDelta(70, 'INTENT_DISINTEREST')).toBe(0);
  });

  it('score nunca vai abaixo de 0', () => {
    expect(applyScoreDelta(1, 'INTENT_DISINTEREST')).toBe(0);
  });

  it('score nunca passa do limite maximo', () => {
    expect(applyScoreDelta(90, 'INTENT_OPPORTUNITY')).toBe(MAX_LEAD_SCORE);
  });

  it('FIRST_REPLY + REPLY_UNDER_1H = 25 pontos', () => {
    const afterFirst = applyScoreDelta(0, 'FIRST_REPLY');
    expect(applyScoreDelta(afterFirst, 'REPLY_UNDER_1H')).toBe(25);
  });

  it('FORM_COMPLETED incrementa corretamente', () => {
    expect(applyScoreDelta(55, 'FORM_COMPLETED')).toBe(75);
  });
});
