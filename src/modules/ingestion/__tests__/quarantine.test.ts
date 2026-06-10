import { describe, expect, it } from 'vitest';
import { LeadInputSchema } from '../ingestion.schema.js';

const validBase = {
  company_name: 'Empresa X',
  phone: '+5511999999999',
  source: 'manual' as const,
  tenant_id: '00000000-0000-0000-0000-000000000001'
};

describe('Quarentena na ingestão', () => {
  it('rejeita lead sem phone', () => {
    expect(() => LeadInputSchema.parse({ ...validBase, phone: '' })).toThrow();
  });

  it('rejeita phone sem DDI', () => {
    expect(() => LeadInputSchema.parse({ ...validBase, phone: '11999999999' })).toThrow();
  });

  it('aceita lead com website', () => {
    expect(LeadInputSchema.parse({ ...validBase, website: 'https://empresa.com.br' })).toBeTruthy();
  });

  it('aceita lead com instagram', () => {
    expect(LeadInputSchema.parse({ ...validBase, instagram: '@empresa' })).toBeTruthy();
  });

  it('valida tenant_id como UUID', () => {
    expect(() => LeadInputSchema.parse({ ...validBase, tenant_id: 'nao-e-uuid' })).toThrow();
  });
});
