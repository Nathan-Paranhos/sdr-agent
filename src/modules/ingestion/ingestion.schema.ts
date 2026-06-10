import { z } from 'zod';

export const LeadInputSchema = z.object({
  company_name: z.string().min(1).trim(),
  phone: z.string().regex(/^\+\d{10,15}$/, 'Use formato internacional: +5511999999999'),
  website: z.string().url().optional().nullable(),
  instagram: z.string().optional().nullable(),
  contact_name: z.string().optional().nullable(),
  segment: z.string().optional().nullable(),
  source: z.enum(['csv', 'webhook', 'sheets', 'manual']),
  tenant_id: z.string().uuid()
});

export type LeadInput = z.infer<typeof LeadInputSchema>;

export const LeadBatchSchema = z.object({
  leads: z.array(LeadInputSchema).min(1)
});
