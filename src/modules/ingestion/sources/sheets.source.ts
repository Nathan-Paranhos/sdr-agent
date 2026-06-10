import { env } from '../../../config/env.js';
import { LeadInput } from '../ingestion.schema.js';

export type SheetRow = Record<string, string | undefined>;

export function mapSheetRows(rows: SheetRow[]): LeadInput[] {
  return rows.map((row) => ({
    company_name: row.company_name ?? row.empresa ?? '',
    phone: row.phone ?? row.telefone ?? '',
    website: row.website ?? row.site ?? null,
    instagram: row.instagram ?? null,
    contact_name: row.contact_name ?? row.contato ?? null,
    segment: row.segment ?? row.segmento ?? null,
    source: 'sheets',
    tenant_id: row.tenant_id ?? env.DEFAULT_TENANT_ID
  }));
}
