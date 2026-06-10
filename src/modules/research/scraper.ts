import { chromium } from 'playwright';
import { log } from '../../config/logger.js';

function extractGoogleMapsPlaceName(url: string): string | null {
  try {
    const parsed = new URL(url);
    const isGoogleMaps =
      parsed.hostname.includes('google.') &&
      (parsed.pathname.includes('/maps/place/') || parsed.pathname.includes('/place/'));

    if (!isGoogleMaps) return null;

    const segments = parsed.pathname.split('/').filter(Boolean);
    const placeIndex = segments.indexOf('place');
    const placeSegment = placeIndex >= 0 ? segments[placeIndex + 1] : null;
    if (!placeSegment) return null;

    return decodeURIComponent(placeSegment.replace(/\+/g, ' ')).trim() || null;
  } catch {
    return null;
  }
}

export async function scrapeWebsiteText(url: string): Promise<string | null> {
  const googleMapsPlaceName = extractGoogleMapsPlaceName(url);
  if (googleMapsPlaceName) {
    return [
      'Fonte: Google Maps',
      `Nome listado: ${googleMapsPlaceName}`,
      `URL da ficha: ${url}`,
      'Observacao: ficha de localizacao do Google Maps; use apenas o nome listado, o segmento conhecido e demais dados enviados no CSV.'
    ].join('\n');
  }

  const browser = await chromium.launch({ headless: true }).catch((err) => {
    log.warn({ err, url }, 'Falha ao abrir Chromium para scraping do site');
    return null;
  });
  if (!browser) return null;

  try {
    const page = await browser.newPage({ userAgent: 'Mozilla/5.0 SDR Research Bot' });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(1500);
    const text = await page.locator('body').innerText({ timeout: 10_000 });
    return text.replace(/\s+/g, ' ').trim().slice(0, 20_000) || null;
  } catch (err) {
    log.warn({ err, url }, 'Falha ao fazer scraping do site');
    return null;
  } finally {
    await browser.close();
  }
}
