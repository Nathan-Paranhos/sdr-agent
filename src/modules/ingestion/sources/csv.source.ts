import { parse } from 'csv-parse/sync';
import { env } from '../../../config/env.js';
import { LeadInput } from '../ingestion.schema.js';

type CsvRecord = Record<string, string | undefined>;
type CsvRow = string[];

const PHONE_HEADER_KEYS = new Set(['phone', 'telefone', 'whatsapp']);

function value(row: CsvRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const found = row[key] ?? row[key.toLowerCase()] ?? row[key.toUpperCase()];
    if (found?.trim()) return found.trim();
  }
  return undefined;
}

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase();
}

function looksLikePhone(valueToCheck: string | undefined): boolean {
  const digits = valueToCheck?.replace(/\D/g, '') ?? '';
  return digits.length >= 10 && digits.length <= 15;
}

function findPhoneHeaderIndex(headers: string[]): number {
  const found = headers.findIndex((header) => PHONE_HEADER_KEYS.has(normalizeHeader(header)));
  return found >= 0 ? found : 1;
}

function repairRowLength(row: CsvRow, headers: string[]): CsvRow {
  const expectedLength = headers.length;
  if (row.length <= expectedLength) return row;

  const phoneHeaderIndex = findPhoneHeaderIndex(headers);
  const phoneValueIndex = row.findIndex((item) => looksLikePhone(item));
  let repaired = [...row];

  if (phoneValueIndex > phoneHeaderIndex && phoneHeaderIndex > 0) {
    repaired = [
      ...row.slice(0, phoneHeaderIndex - 1),
      row.slice(phoneHeaderIndex - 1, phoneValueIndex).join(', '),
      ...row.slice(phoneValueIndex)
    ];
  }

  if (repaired.length > expectedLength) {
    repaired = [
      ...repaired.slice(0, expectedLength - 1),
      repaired.slice(expectedLength - 1).join(', ')
    ];
  }

  return repaired;
}

function rowToRecord(headers: string[], row: CsvRow): CsvRecord {
  const repaired = repairRowLength(row, headers);
  return Object.fromEntries(headers.map((header, index) => [normalizeHeader(header), repaired[index]?.trim()]));
}

export function parseCsvLeads(csv: string): LeadInput[] {
  const records = parse(csv, {
    bom: true,
    columns: false,
    relax_column_count: true,
    relax_quotes: true,
    skip_records_with_error: true,
    skip_empty_lines: true,
    trim: true
  }) as CsvRow[];

  const headers = records[0]?.map(normalizeHeader) ?? [];
  if (headers.length === 0) return [];

  const rows = records.slice(1).map((row) => rowToRecord(headers, row));

  return rows.map((row) => ({
    company_name: value(row, 'company_name', 'empresa', 'company') ?? '',
    phone: value(row, 'phone', 'telefone', 'whatsapp') ?? '',
    website: value(row, 'website', 'site', 'source_url', 'url') ?? null,
    instagram: value(row, 'instagram') ?? null,
    contact_name: value(row, 'contact_name', 'contato', 'nome') ?? null,
    segment: value(row, 'segment', 'segmento') ?? null,
    source: 'csv',
    tenant_id: value(row, 'tenant_id') ?? env.DEFAULT_TENANT_ID
  }));
}
