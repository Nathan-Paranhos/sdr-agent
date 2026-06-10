import { chromium } from 'playwright';
import { log } from '../../config/logger.js';

export interface InstagramData {
  bio: string;
  recentPosts: string[];
}

export async function scrapeInstagram(handleOrUrl: string): Promise<InstagramData | null> {
  const url = handleOrUrl.startsWith('http')
    ? handleOrUrl
    : `https://www.instagram.com/${handleOrUrl.replace('@', '')}/`;

  const browser = await chromium.launch({ headless: true }).catch((err) => {
    log.warn({ err, url }, 'Falha ao abrir Chromium para scraping do Instagram');
    return null;
  });
  if (!browser) return null;

  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2500);
    const body = await page.locator('body').innerText({ timeout: 10_000 });
    const lines = body.split('\n').map((line) => line.trim()).filter(Boolean);
    return {
      bio: lines.slice(0, 12).join(' ').slice(0, 1000),
      recentPosts: lines.slice(12, 40).filter((line) => line.length > 20).slice(0, 9)
    };
  } catch (err) {
    log.warn({ err, url }, 'Falha ao fazer scraping do Instagram');
    return null;
  } finally {
    await browser.close();
  }
}
