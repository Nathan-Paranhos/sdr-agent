import { describe, expect, it, vi } from 'vitest';

const ENV_BACKUP = { ...process.env };

process.env.GROUP_MANAGER_HACKERNEWS_LIMIT = '10';
process.env.GROUP_MANAGER_NEWS_TOP_N = '3';
process.env.GROUP_MANAGER_NEWSAPI_KEY = '';
process.env.GROUP_MANAGER_NEWSAPI_COUNTRY = 'us';
process.env.GROUP_MANAGER_NEWSAPI_CATEGORY = 'technology';

const { fetchTechNews, dedupeByTitle } = await import('../news-fetcher.js');

describe('News Fetcher - dedupe and formatting', () => {
  it('retorna rawText vazio amigavel quando nao ha fontes', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500
    }) as unknown as typeof fetch;

    try {
      const result = await fetchTechNews(3);
      expect(result.items).toEqual([]);
      expect(result.rawText).toContain('nenhuma noticia');
      expect(result.sourcesUsed).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('deduplica por titulo entre HackerNews e NewsAPI', () => {
    const items = [
      { source: 'hackernews' as const, title: 'OpenAI releases new SDK', url: 'a', summary: '', publishedAt: null },
      { source: 'newsapi' as const, title: 'OpenAI releases new SDK', url: 'b', summary: '', publishedAt: null },
      { source: 'newsapi' as const, title: 'GitHub Copilot update', url: 'c', summary: '', publishedAt: null }
    ];

    const result = dedupeByTitle(items);
    expect(result).toHaveLength(2);
    expect(result[0]?.source).toBe('hackernews');
    expect(result[1]?.title).toBe('GitHub Copilot update');
  });

  it('combina fontes e formata o rawText com titulos e links', async () => {
    const items = dedupeByTitle([
      { source: 'hackernews' as const, title: 'Rust 1.90 released', url: 'https://example.com/rust', summary: 'compilador mais rapido', publishedAt: null },
      { source: 'newsapi' as const, title: 'GPT-5 announced', url: 'https://example.com/gpt5', summary: '', publishedAt: null }
    ]);
    expect(items).toHaveLength(2);

    const realFetch = globalThis.fetch;
    let topCall = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('topstories.json')) {
        topCall++;
        if (topCall > 1) return { ok: false, status: 500 };
        return { ok: true, status: 200, json: async () => [1] };
      }
      if (u.includes('/item/')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 1, title: 'Rust 1.90 released', url: 'https://example.com/rust', time: 1717000000 })
        };
      }
      return { ok: false, status: 404 };
    }) as unknown as typeof fetch;

    try {
      const result = await fetchTechNews(3);
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.rawText).toContain('Rust 1.90 released');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
