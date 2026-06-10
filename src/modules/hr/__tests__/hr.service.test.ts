import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock pdf-parse
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

// Mock callLLM from groq client
vi.mock('../../../integrations/groq/llm.client.js', () => {
  return {
    callLLM: vi.fn().mockResolvedValue({
      text: 'Mocked LLM Analysis: John Doe matches Software Engineer roles.',
      model: 'llama-3.3-70b-versatile',
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      durationMs: 120
    })
  };
});

// Import the module under test
import { fetchBrazilianJobs, extractTextFromPdf, analyzeCvAndMatchJobs } from '../hr.service.js';
import { callLLM } from '../../../integrations/groq/llm.client.js';

describe('HR Service - CV Parsing and Job Matching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('fetchBrazilianJobs', () => {
    it('should fetch and format jobs from GitHub fallback when Adzuna keys are absent', async () => {
      const mockGitHubIssues = [
        {
          title: '[Campinas/Remoto] Developer Node.js',
          html_url: 'https://github.com/backend-br/vagas/issues/1',
          body: 'Vaga remota ou presencial em Campinas'
        },
        {
          title: '[São Paulo] Java Developer',
          html_url: 'https://github.com/backend-br/vagas/issues/2',
          body: 'Vaga na capital'
        }
      ];

      const globalFetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockGitHubIssues
      });
      vi.stubGlobal('fetch', globalFetchMock);

      const jobs = await fetchBrazilianJobs();

      expect(globalFetchMock).toHaveBeenCalled();
      // Only the Campinas/Remoto job should match the filter (returns once per queried repo)
      expect(jobs).toHaveLength(2);
      expect(jobs[0]).toEqual({
        title: '[Campinas/Remoto] Developer Node.js',
        company_name: 'GitHub Vagas',
        url: 'https://github.com/backend-br/vagas/issues/1',
        tags: ['backend-br']
      });

      vi.unstubAllGlobals();
    });

    it('should return empty array on fallback failure', async () => {
      const globalFetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500
      });
      vi.stubGlobal('fetch', globalFetchMock);

      const jobs = await fetchBrazilianJobs();
      expect(jobs).toEqual([]);

      vi.unstubAllGlobals();
    });
  });

  describe('extractTextFromPdf', () => {
    it('should extract text from pdf buffer', async () => {
      const buffer = Buffer.from('dummy-pdf-data');
      const text = await extractTextFromPdf(buffer);
      // Since we mocked pdf-parse globally, it will return the mocked string
      expect(text).toContain('John Doe');
    });
  });

  describe('analyzeCvAndMatchJobs', () => {
    it('should orchestrate CV parsing, job fetching and LLM analysis', async () => {
      const mockGitHubIssues = [
        {
          title: '[Remoto] React Developer',
          html_url: 'https://github.com/frontendbr/vagas/issues/1',
          body: 'Trabalho remoto de desenvolvimento frontend'
        }
      ];
      const globalFetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockGitHubIssues
      });
      vi.stubGlobal('fetch', globalFetchMock);

      const buffer = Buffer.from('my-cv-pdf');
      const result = await analyzeCvAndMatchJobs(buffer);

      expect(callLLM).toHaveBeenCalledOnce();
      expect(callLLM).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: expect.stringContaining('extremamente crítico'),
          userContent: expect.stringContaining('John Doe')
        })
      );
      expect(result).toBe('Mocked LLM Analysis: John Doe matches Software Engineer roles.');

      vi.unstubAllGlobals();
    });
  });
});
