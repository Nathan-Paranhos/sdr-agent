import { describe, expect, it } from 'vitest';
import { parseCsvLeads } from './csv.source.js';

describe('parseCsvLeads', () => {
  it('corrige nome de empresa com virgula sem quebrar colunas', () => {
    const csv = [
      'company_name,phone,website,instagram,contact_name,segment,source_url,research_note',
      'Dentista Morumbi, Sao Paulo - Dra Larissa Tavares,+5511951307605,https://example.com,https://instagram.com/dra,Dra Larissa,odontologia,https://example.com,Nota'
    ].join('\n');

    const [lead] = parseCsvLeads(csv);
    if (!lead) throw new Error('Lead nao parseado');

    expect(lead).toMatchObject({
      company_name: 'Dentista Morumbi, Sao Paulo - Dra Larissa Tavares',
      phone: '+5511951307605',
      website: 'https://example.com',
      instagram: 'https://instagram.com/dra',
      contact_name: 'Dra Larissa',
      segment: 'odontologia'
    });
  });

  it('junta virgulas extras na ultima coluna de observacao', () => {
    const csv = [
      'company_name,phone,website,instagram,contact_name,segment,source_url,research_note',
      'Empresa X,+5511999999999,https://example.com,,Contato,servico,https://example.com,Primeira parte, segunda parte'
    ].join('\n');

    const [lead] = parseCsvLeads(csv);
    if (!lead) throw new Error('Lead nao parseado');

    expect(lead.company_name).toBe('Empresa X');
    expect(lead.phone).toBe('+5511999999999');
    expect(lead.website).toBe('https://example.com');
  });

  it('usa source_url como website quando a coluna website vem vazia', () => {
    const csv = [
      'company_name,phone,website,instagram,contact_name,segment,source_url,research_note',
      'Empresa Maps,+5511999999999,,,Contato,restaurante,https://www.google.com/maps/place/Empresa+Maps,Fonte: Google Maps'
    ].join('\n');

    const [lead] = parseCsvLeads(csv);
    if (!lead) throw new Error('Lead nao parseado');

    expect(lead.website).toBe('https://www.google.com/maps/place/Empresa+Maps');
  });
});
