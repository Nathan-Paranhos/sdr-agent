import 'dotenv/config';
import { vi } from 'vitest';

process.env.GROQ_API_KEY ??= 'test-groq-key';
process.env.DEFAULT_TENANT_ID ??= '00000000-0000-0000-0000-000000000001';
process.env.DEFAULT_AGENT_NAME ??= 'Nathan';
process.env.DEFAULT_SERVICE_CATEGORY ??= 'automacao comercial e atendimento via WhatsApp';
process.env.OPERATOR_PHONE ??= '+5511996961151';
process.env.OPERATOR_SECRET ??= 'test-secret';

vi.mock('pdf-parse', () => {
  const mockGetText = vi.fn().mockResolvedValue({ text: 'John Doe - Software Engineer' });
  const mockDestroy = vi.fn().mockResolvedValue(undefined);
  return {
    PDFParse: vi.fn().mockImplementation(() => {
      return {
        getText: mockGetText,
        destroy: mockDestroy
      };
    })
  };
});
