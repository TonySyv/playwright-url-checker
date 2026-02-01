import { Page, Response } from 'playwright';

export type WebsiteStatus = '5xx' | '404' | 'Parked' | 'Broken' | 'ok' | 'Other';

/** Max chars of body text to send to LLM (keep under typical context limits) */
const LLM_CONTENT_MAX_CHARS = 3000;

/** Call OpenAI to decide from context if the page is actually parked (vs. coincidence of keywords). */
async function askLLMIsParked(pageSummary: string): Promise<'parked' | 'normal' | 'skip'> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || process.env.USE_LLM_PARKED === '0') return 'skip';

  const prompt = `You are classifying web pages. The following text is from a single web page (title, meta description, and start of body content).

Determine if this page is a PARKED DOMAIN page (domain for sale, domain parking, placeholder "buy this domain" page, parking service) or a NORMAL website (e-commerce, blog, company site, news, etc.). Normal sites may mention "hosting", "for sale", "make an offer" in a product/commercial context—that is NOT parked.

Reply with exactly one line: PARKED or NORMAL, then a brief reason (a few words). Example: "NORMAL - e-commerce product page" or "PARKED - domain for sale landing page".

Page content:
---
${pageSummary}
---`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 80,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return 'skip';
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim() || '';
    const upper = text.toUpperCase();
    if (upper.startsWith('NORMAL')) return 'normal';
    if (upper.startsWith('PARKED')) return 'parked';
    return 'skip';
  } catch {
    return 'skip';
  }
}

/** Extract title, meta description, and start of body for LLM. */
async function getPageSummaryForLLM(page: Page): Promise<string> {
  try {
    const raw = await page.evaluate((maxLen: number) => {
      const title = document.title || '';
      const meta = document.querySelector('meta[name="description"]');
      const metaDesc = (meta && meta.getAttribute('content')) || '';
      const bodyText = document.body?.innerText?.trim() || '';
      const bodySnippet = bodyText.slice(0, maxLen);
      return { title, metaDesc, bodySnippet };
    }, LLM_CONTENT_MAX_CHARS);
    const parts = [
      raw.title && `Title: ${raw.title}`,
      raw.metaDesc && `Description: ${raw.metaDesc}`,
      `Content:\n${raw.bodySnippet}`,
    ].filter(Boolean);
    return parts.join('\n\n');
  } catch {
    return '';
  }
}

export interface StatusResult {
  status: WebsiteStatus;
  notes?: string;
}

/**
 * Returns true if the page has substantial content (not just a small "Forbidden" or error body).
 * Used to avoid marking sites as Broken when they return 403 to bots but still serve content.
 */
async function pageHasSubstantialContent(page: Page): Promise<boolean> {
  try {
    const bodyText = await page.textContent('body') || '';
    const bodyTrim = bodyText.trim();
    const bodyLower = bodyTrim.toLowerCase();

    // Tiny or generic error pages
    if (bodyTrim.length < 400) return false;
    if (bodyLower.includes('access denied') && bodyTrim.length < 800) return false;
    if (bodyLower.includes('forbidden') && bodyTrim.length < 800 && !bodyLower.includes('stack overflow')) return false;
    if (bodyLower === 'forbidden' || bodyLower === 'access denied') return false;

    const elementCount = await page.evaluate(() => document.querySelectorAll('*').length);
    if (elementCount < 15) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * Detects if a page is parked (hosting page, or for sale) by looking for
 * explicit parked/hosting wording. Minimal content alone is not used,
 * since many legitimate sites have minimal content.
 */
async function isParkedPage(page: Page): Promise<boolean> {
  try {
    const bodyText = await page.textContent('body') || '';
    const title = await page.title() || '';
    const bodyTextLower = bodyText.toLowerCase();
    const titleLower = title.toLowerCase();

    // Common parked page indicators (must see at least one). Use specific phrases to avoid
    // false positives on e-commerce (e.g. "make an offer", "hosting" on Amazon).
    const parkedIndicators = [
      'parked',
      'domain for sale',
      'this domain may be for sale',
      'this domain is for sale',
      'domain is for sale',
      'buy this domain',
      'buy domain',
      'sell this domain',
      'domain name registration',
      'domain parking',
      'this domain is parked',
      'this page is parked',
      'parking page',
      'domain parking service',
      'cashparking',
      'parked by',
      'this domain is coming soon',
      'domain is available',
      'register this domain',
      'list your domain',
      'make an offer on this domain',
      'make an offer for this domain',
      'request price for this domain',
      'this domain is available for purchase',
      'domain available for purchase',
      'domain marketplace',
      'premium domain',
      'undeveloped',
      'put a for sale sign',
      'for sale sign on your domain',
      'godaddy',
      'namecheap',
      'sedo',
      'sedoparking',
      'dan.com',
      'afternic',
      'hugedomains',
      'flippa',
      'brandbucket',
      'escrow.com',
      'uniregistry',
      'epik.com',
    ];

    let hasParkedKeyword = false;
    for (const indicator of parkedIndicators) {
      if (titleLower.includes(indicator) || bodyTextLower.includes(indicator)) {
        hasParkedKeyword = true;
        break;
      }
    }

    // Common hosting provider / default server pages
    if (!hasParkedKeyword) {
      const hostingProviders = [
        'cpanel',
        'plesk',
        'powered by cpanel',
        'powered by plesk',
        'default page',
        'default website',
        'apache',
        'apache2',
        'nginx',
        'welcome to nginx',
        'welcome to apache',
        'welcome to',
        'it works!',
        'test page',
        'test page for',
        'ubuntu default',
        'centos default',
        'no web site is configured',
        'index of /',
        'directory listing',
      ];
      for (const provider of hostingProviders) {
        if (titleLower.includes(provider) || bodyTextLower.includes(provider)) {
          hasParkedKeyword = true;
          break;
        }
      }
    }

    return hasParkedKeyword;
  } catch (error) {
    return false;
  }
}

/**
 * Detects if a page is broken (under construction, error messages, broken layout)
 */
async function isBrokenPage(page: Page): Promise<boolean> {
  try {
    const bodyText = await page.textContent('body') || '';
    const title = await page.title() || '';
    const bodyTextLower = bodyText.toLowerCase();
    const titleLower = title.toLowerCase();

    // Common broken/construction indicators
    const brokenIndicators = [
      'under construction',
      'coming soon',
      'site under maintenance',
      'maintenance mode',
      'temporarily unavailable',
      'we are working on',
      'this site is being rebuilt',
      'page not found',
      'error occurred',
      'something went wrong',
      'internal server error',
      'database error',
      'connection error',
      'fatal error',
      'parse error',
      'syntax error',
    ];

    for (const indicator of brokenIndicators) {
      if (titleLower.includes(indicator) || bodyTextLower.includes(indicator)) {
        return true;
      }
    }

    // Check for common error page patterns
    const errorPatterns = [
      /error\s+\d{3}/i,
      /http\s+error/i,
      /server\s+error/i,
      /application\s+error/i,
    ];

    for (const pattern of errorPatterns) {
      if (pattern.test(bodyText) || pattern.test(title)) {
        return true;
      }
    }

    // Check for broken layout (very few elements or mostly empty)
    const elementCount = await page.evaluate(() => {
      // @ts-ignore - This code runs in browser context, not Node.js
      return document.querySelectorAll('*').length;
    });

    if (elementCount < 10 && bodyText.trim().length < 200) {
      return true;
    }

    return false;
  } catch (error) {
    return false;
  }
}

/**
 * Analyzes a page and determines its status
 */
export async function detectStatus(
  page: Page,
  response: Response | null,
  url: string
): Promise<StatusResult> {
  try {
    // Check HTTP status code first
    if (response) {
      const status = response.status();

      // 5xx server errors
      if (status >= 500 && status < 600) {
        return { status: '5xx', notes: `HTTP ${status}` };
      }

      // 404 not found
      if (status === 404) {
        return { status: '404', notes: 'HTTP 404' };
      }

      // 403 Forbidden: many sites (npm, Stack Overflow, Reddit) return 403 to headless/bots
      // but still serve content. If the page has substantial content, treat as ok.
      if (status === 403) {
        const hasRealContent = await pageHasSubstantialContent(page);
        if (hasRealContent) {
          return { status: 'ok', notes: 'HTTP 403 but content loaded (possible bot block)' };
        }
        return { status: 'Broken', notes: `HTTP ${status}` };
      }

      // Other 4xx errors might be considered broken
      if (status >= 400 && status < 500 && status !== 404) {
        return { status: 'Broken', notes: `HTTP ${status}` };
      }
    }

    // If no response or response is null, it might be a timeout/network error
    // This should be handled by the caller as 5xx

    // Wait for page to be fully loaded
    try {
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
        // Continue even if networkidle doesn't complete
      });
    } catch (error) {
      // Continue with analysis even if wait fails
    }

    // Check for parked pages (site loads but appears to be parked/placeholder)
    const parked = await isParkedPage(page);
    if (parked) {
      // Optional: ask LLM from context to avoid false positives (e.g. Amazon with "hosting")
      const summary = await getPageSummaryForLLM(page);
      const llmVerdict = summary ? await askLLMIsParked(summary) : 'skip';
      if (llmVerdict === 'normal') {
        // LLM says not parked; treat as ok (keywords were coincidence)
      } else {
        return {
          status: 'Parked',
          notes: llmVerdict === 'parked' ? 'Parked domain (LLM confirmed)' : 'Website loads fine, Parked domain detected',
        };
      }
    }

    // Check for broken pages
    const broken = await isBrokenPage(page);
    if (broken) {
      return { status: 'Broken', notes: 'Broken/under construction detected' };
    }

    // If we got here and have a valid response (200-299), it's ok
    if (response && response.status() >= 200 && response.status() < 300) {
      return { status: 'ok', notes: 'Website loads fine' };
    }

    // Default to ok if we can't determine otherwise
    return { status: 'ok', notes: 'Website appears to load' };
  } catch (error) {
    // If we can't analyze the page, mark as Other
    return {
      status: 'Other',
      notes: `Analysis error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}
