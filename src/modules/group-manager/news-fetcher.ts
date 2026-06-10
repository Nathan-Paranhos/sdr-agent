import { env } from '../../config/env.js';
import { log } from '../../config/logger.js';

export interface NewsItem {
  source: 'hackernews' | 'newsapi';
  title: string;
  url: string;
  summary: string;
  publishedAt: string | null;
}

export interface FetchedNews {
  items: NewsItem[];
  rawText: string;
  sourcesUsed: string[];
}

const HN_TOP_STORIES_URL = 'https://hacker-news.firebaseio.com/v0/topstories.json';
const HN_ITEM_URL = (id: number) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
const NEWSAPI_TOP_URL = 'https://newsapi.org/v2/top-headlines';

async function fetchHackerNews(limit: number): Promise<NewsItem[]> {
  try {
    const response = await fetch(HN_TOP_STORIES_URL, {
      headers: { 'User-Agent': 'sdr-agent-group-manager' }
    });
    if (!response.ok) {
      log.warn({ status: response.status }, 'HackerNews topstories retornou status nao OK');
      return [];
    }
    const ids = (await response.json()) as number[];
    if (!Array.isArray(ids)) return [];

    const slice = ids.slice(0, limit);
    const items: NewsItem[] = [];
    await Promise.all(
      slice.map(async (id) => {
        try {
          const r = await fetch(HN_ITEM_URL(id), { headers: { 'User-Agent': 'sdr-agent-group-manager' } });
          if (!r.ok) return;
          const data = (await r.json()) as {
            id?: number;
            title?: string;
            url?: string;
            text?: string;
            time?: number;
          };
          if (!data.title) return;
          items.push({
            source: 'hackernews',
            title: data.title,
            url: data.url ?? `https://news.ycombinator.com/item?id=${data.id ?? id}`,
            summary: data.text ? data.text.slice(0, 280) : '',
            publishedAt: data.time ? new Date(data.time * 1000).toISOString() : null
          });
        } catch {
          // item descartado
        }
      })
    );

    return items;
  } catch (err) {
    log.warn({ err }, 'Falha ao buscar HackerNews');
    return [];
  }
}

async function fetchNewsApi(limit: number): Promise<NewsItem[]> {
  const apiKey = env.GROUP_MANAGER_NEWSAPI_KEY?.trim();
  if (!apiKey) {
    log.debug('NewsAPI desabilitado (sem chave configurada)');
    return [];
  }

  const params = new URLSearchParams({
    apiKey,
    category: env.GROUP_MANAGER_NEWSAPI_CATEGORY,
    pageSize: String(Math.min(limit, 50)),
    language: 'en'
  });
  if (env.GROUP_MANAGER_NEWSAPI_COUNTRY) {
    params.set('country', env.GROUP_MANAGER_NEWSAPI_COUNTRY);
  }

  try {
    const response = await fetch(`${NEWSAPI_TOP_URL}?${params.toString()}`, {
      headers: { 'User-Agent': 'sdr-agent-group-manager' }
    });
    if (!response.ok) {
      log.warn({ status: response.status }, 'NewsAPI retornou status nao OK');
      return [];
    }
    const data = (await response.json()) as {
      status?: string;
      articles?: Array<{
        title?: string;
        url?: string;
        description?: string;
        publishedAt?: string;
        source?: { name?: string };
      }>;
    };
    if (data.status !== 'ok' || !Array.isArray(data.articles)) return [];

    return data.articles
      .filter((article) => article.title && article.url)
      .map((article) => ({
        source: 'newsapi' as const,
        title: article.title as string,
        url: article.url as string,
        summary: article.description ?? '',
        publishedAt: article.publishedAt ?? null
      }));
  } catch (err) {
    log.warn({ err }, 'Falha ao buscar NewsAPI');
    return [];
  }
}

function dedupeByTitleInternal(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const result: NewsItem[] = [];
  for (const item of items) {
    const key = item.title.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

export const dedupeByTitle = dedupeByTitleInternal;

export async function fetchTechNews(topN: number): Promise<FetchedNews> {
  const hnLimit = Math.max(env.GROUP_MANAGER_HACKERNEWS_LIMIT, topN * 3);
  const newsApiLimit = Math.max(topN * 3, 10);

  const [hn, newsApi] = await Promise.all([fetchHackerNews(hnLimit), fetchNewsApi(newsApiLimit)]);
  const combined = dedupeByTitleInternal([...hn, ...newsApi]);

  const sourcesUsed: string[] = [];
  if (hn.length > 0) sourcesUsed.push(`HackerNews (${hn.length})`);
  if (newsApi.length > 0) sourcesUsed.push(`NewsAPI (${newsApi.length})`);

  const top = combined.slice(0, Math.max(topN, 1));

  const rawText = top
    .map((item, index) => {
      const sourceLabel = item.source === 'hackernews' ? 'HackerNews' : 'NewsAPI';
      const summary = item.summary ? ` - ${item.summary}` : '';
      return `${index + 1}. [${sourceLabel}] ${item.title}${summary}\n   ${item.url}`;
    })
    .join('\n\n');

  return {
    items: top,
    rawText: rawText || '(nenhuma noticia disponivel hoje)',
    sourcesUsed
  };
}
