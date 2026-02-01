import { Page, Response } from 'playwright';

export type WebsiteStatus = '5xx' | '404' | 'Parked' | 'Broken' | 'ok' | 'Other';

export interface StatusResult {
  status: WebsiteStatus;
  notes?: string;
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

    // Common parked page indicators (must see at least one)
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
      'hosting',
      'coming soon',
      'under construction',
      'domain is available',
      'register this domain',
      'list your domain',
      'make an offer',
      'request price',
      'available for purchase',
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
      return { status: 'Parked', notes: 'Website loads fine, Parked domain detected' };
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
