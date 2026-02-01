import { chromium, Browser, BrowserContext, Page, Response } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import csv from 'csv-parser';
import { createObjectCsvWriter } from 'csv-writer';
import pLimit from 'p-limit';
import { detectStatus, WebsiteStatus } from './status-detector';

interface InputRow {
  Domain: string;
  [key: string]: string;
}

interface OutputRow {
  Domain: string;
  Status: WebsiteStatus;
  Timestamp: string;
  Notes?: string;
}

interface CheckResult {
  domain: string;
  status: WebsiteStatus;
  notes?: string;
  error?: string;
}

/**
 * Normalizes a domain/URL to a full URL
 */
function normalizeUrl(domain: string): string {
  domain = domain.trim();
  if (!domain) {
    throw new Error('Empty domain');
  }

  // Remove leading/trailing whitespace and slashes
  domain = domain.trim().replace(/^\/+|\/+$/g, '');

  // If it doesn't start with http:// or https://, add https://
  if (!/^https?:\/\//i.test(domain)) {
    domain = `https://${domain}`;
  }

  return domain;
}

/**
 * Turns a raw Playwright/browser error into a short, human-readable note for the CSV.
 */
function toHumanReadableNote(rawError: string, attemptCount?: number): string {
  // Use only the first line; strip "Call log:" and everything after
  const firstLine = rawError.split(/\r?\n/)[0].trim();
  const prefix = attemptCount != null ? `After ${attemptCount} attempts: ` : '';

  // Map known network/error codes to short phrases
  if (firstLine.includes('net::ERR_EMPTY_RESPONSE')) {
    return `${prefix}Server closed connection without sending data`;
  }
  if (firstLine.includes('net::ERR_CONNECTION_REFUSED')) {
    return `${prefix}Connection refused`;
  }
  if (firstLine.includes('net::ERR_NAME_NOT_RESOLVED') || firstLine.includes('ERR_NAME_NOT_RESOLVED')) {
    return `${prefix}Domain could not be resolved`;
  }
  if (firstLine.includes('net::ERR_CONNECTION_RESET')) {
    return `${prefix}Connection was reset`;
  }
  if (firstLine.includes('net::ERR_CONNECTION_TIMED_OUT') || firstLine.includes('ERR_CONNECTION_TIMED_OUT')) {
    return `${prefix}Connection timed out`;
  }
  if (firstLine.includes('net::ERR_SSL_') || firstLine.includes('ERR_CERT_')) {
    return `${prefix}SSL or certificate error`;
  }
  if (firstLine.includes('Navigation timeout') || firstLine.includes('timeout') && firstLine.includes('30000')) {
    return `${prefix}Page load timed out`;
  }
  if (firstLine.includes('timeout')) {
    return `${prefix}Request timed out`;
  }
  if (firstLine.includes('net::')) {
    // Other net:: errors: show a short generic message plus the code if it's brief
    const match = firstLine.match(/net::(ERR_[A-Z_]+)/);
    const code = match ? match[1].replace(/_/g, ' ') : 'network error';
    return `${prefix}${code}`;
  }

  // Fallback: use first line but cap length
  const maxLen = 120;
  if (firstLine.length <= maxLen) return `${prefix}${firstLine}`;
  return `${prefix}${firstLine.slice(0, maxLen)}…`;
}

/** Realistic Chrome User-Agent to reduce 403 bot blocks from sites like npm, Stack Overflow, Reddit */
const REALISTIC_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * Checks a single URL with retry logic for 5xx errors
 */
async function checkUrl(
  context: BrowserContext,
  url: string,
  maxRetries: number = 3
): Promise<CheckResult> {
  let lastError: Error | null = null;
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let page: Page | null = null;
    try {
      // Exponential backoff: 1s, 2s, 4s
      if (attempt > 0) {
        const delay = Math.pow(2, attempt - 1) * 1000;
        console.log(`  Retry ${attempt}/${maxRetries} for ${url} after ${delay}ms delay`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      page = await context.newPage();

      // Set timeout for page load
      page.setDefaultTimeout(30000); // 30 seconds

      // Navigate to the URL
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      lastResponse = response;

      // Check HTTP status
      if (response) {
        const status = response.status();

        // If 5xx error and we have retries left, retry
        if (status >= 500 && status < 600 && attempt < maxRetries) {
          await page.close();
          lastError = new Error(`HTTP ${status}`);
          continue; // Retry
        }

        // If 404, check the page content to confirm
        if (status === 404) {
          const result = await detectStatus(page, response, url);
          await page.close();
          return {
            domain: url,
            status: result.status,
            notes: result.notes,
          };
        }

        // For other statuses, analyze the page
        const result = await detectStatus(page, response, url);

        // If we got 5xx and no more retries, return 5xx
        if (status >= 500 && status < 600) {
          await page.close();
          return {
            domain: url,
            status: '5xx',
            notes: `HTTP ${status} after ${attempt + 1} attempts`,
          };
        }

        await page.close();
        return {
          domain: url,
          status: result.status,
          notes: result.notes,
        };
      } else {
        // No response - might be a navigation issue
        const result = await detectStatus(page, null, url);
        await page.close();
        return {
          domain: url,
          status: result.status,
          notes: result.notes || 'No HTTP response received',
        };
      }
    } catch (error) {
      if (page) {
        try {
          await page.close();
        } catch (closeError) {
          // Ignore close errors
        }
      }

      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if it's a timeout or network error (should retry for 5xx)
      if (
        (errorMessage.includes('timeout') ||
          errorMessage.includes('net::') ||
          errorMessage.includes('Navigation timeout') ||
          errorMessage.includes('ERR_')) &&
        attempt < maxRetries
      ) {
        lastError = error instanceof Error ? error : new Error(errorMessage);
        continue; // Retry
      }

      // If it's a navigation error or other error, try to determine status
      if (attempt === maxRetries) {
        // Last attempt failed - mark as 5xx if it was a network/timeout error
        if (
          errorMessage.includes('timeout') ||
          errorMessage.includes('net::') ||
          errorMessage.includes('Navigation timeout') ||
          errorMessage.includes('ERR_')
        ) {
          return {
            domain: url,
            status: '5xx',
            notes: toHumanReadableNote(errorMessage, attempt + 1),
            error: errorMessage,
          };
        }

        // Other errors might be Other status
        return {
          domain: url,
          status: 'Other',
          notes: toHumanReadableNote(errorMessage, attempt + 1),
          error: errorMessage,
        };
      }

      lastError = error instanceof Error ? error : new Error(errorMessage);
    }
  }

  // If we exhausted all retries and still have an error, return 5xx
  const finalError = lastError?.message || 'Unknown error';
  return {
    domain: url,
    status: '5xx',
    notes: toHumanReadableNote(finalError, maxRetries + 1),
    error: lastError?.message,
  };
}

/**
 * Reads URLs from CSV file
 */
async function readUrlsFromCsv(filePath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const urls: string[] = [];
    const normalizedUrls = new Set<string>(); // To avoid duplicates

    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row: InputRow) => {
        const domain = row.Domain || row.domain || row.URL || row.url || '';
        if (domain.trim()) {
          try {
            const normalized = normalizeUrl(domain);
            if (!normalizedUrls.has(normalized)) {
              normalizedUrls.add(normalized);
              urls.push(normalized);
            }
          } catch (error) {
            console.warn(`Skipping invalid domain: ${domain}`);
          }
        }
      })
      .on('end', () => {
        console.log(`Loaded ${urls.length} unique URLs from ${filePath}`);
        resolve(urls);
      })
      .on('error', (error) => {
        reject(error);
      });
  });
}

/**
 * Writes results to CSV file
 */
async function writeResultsToCsv(
  results: CheckResult[],
  outputPath: string
): Promise<void> {
  const csvWriter = createObjectCsvWriter({
    path: outputPath,
    header: [
      { id: 'Domain', title: 'Domain' },
      { id: 'Status', title: 'Status' },
      { id: 'Timestamp', title: 'Timestamp' },
      { id: 'Notes', title: 'Notes' },
    ],
  });

  const rows: OutputRow[] = results.map((result) => ({
    Domain: result.domain,
    Status: result.status,
    Timestamp: new Date().toISOString(),
    Notes: result.notes || result.error || '',
  }));

  await csvWriter.writeRecords(rows);
  console.log(`Results written to ${outputPath}`);
}

/**
 * Main function
 */
async function main() {
  const inputFile = process.argv[2] || 'input.csv';
  const outputFile = process.argv[3] || 'output.csv';
  const concurrency = parseInt(process.argv[4] || '4', 10); // Default to 4 (between 3-5)

  console.log('='.repeat(60));
  console.log('URL Status Checker');
  console.log('='.repeat(60));
  console.log(`Input file: ${inputFile}`);
  console.log(`Output file: ${outputFile}`);
  console.log(`Concurrency: ${concurrency}`);
  console.log(`VPN should be ON on your machine`);
  console.log('='.repeat(60));

  // Check if input file exists
  if (!fs.existsSync(inputFile)) {
    console.error(`Error: Input file "${inputFile}" not found.`);
    console.error('Please provide a CSV file with a "Domain" column.');
    process.exit(1);
  }

  // Read URLs from CSV
  let urls: string[];
  try {
    urls = await readUrlsFromCsv(inputFile);
  } catch (error) {
    console.error(`Error reading input file: ${error}`);
    process.exit(1);
  }

  if (urls.length === 0) {
    console.error('No valid URLs found in input file.');
    process.exit(1);
  }

  // Launch browser with args that reduce bot detection (sites like npm/Stack Overflow/Reddit often 403 headless)
  console.log('\nLaunching browser...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  // Single context with realistic UA and viewport so we look like a normal browser
  const context = await browser.newContext({
    userAgent: REALISTIC_USER_AGENT,
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  });

  // Create concurrency limiter
  const limit = pLimit(concurrency);

  // Process URLs with concurrency control
  console.log(`\nProcessing ${urls.length} URLs with concurrency of ${concurrency}...\n`);

  const results: CheckResult[] = [];
  const startTime = Date.now();

  // Process all URLs
  const promises = urls.map((url, index) =>
    limit(async () => {
      const current = index + 1;
      const total = urls.length;
      console.log(`[${current}/${total}] Checking: ${url}`);

      const result = await checkUrl(context, url);
      results.push(result);

      console.log(
        `[${current}/${total}] ${url} -> ${result.status}${result.notes ? ` (${result.notes})` : ''}`
      );

      return result;
    })
  );

  // Wait for all checks to complete
  await Promise.all(promises);

  // Close context and browser
  await context.close();
  await browser.close();

  // Write results to CSV
  console.log('\nWriting results to CSV...');
  await writeResultsToCsv(results, outputFile);

  // Print summary
  const endTime = Date.now();
  const duration = ((endTime - startTime) / 1000 / 60).toFixed(2);

  console.log('\n' + '='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(`Total URLs checked: ${results.length}`);
  console.log(`Time taken: ${duration} minutes`);

  const statusCounts: Record<WebsiteStatus, number> = {
    '5xx': 0,
    '404': 0,
    Parked: 0,
    Broken: 0,
    ok: 0,
    Other: 0,
  };

  results.forEach((result) => {
    statusCounts[result.status]++;
  });

  console.log('\nStatus breakdown:');
  Object.entries(statusCounts).forEach(([status, count]) => {
    console.log(`  ${status}: ${count}`);
  });

  console.log('='.repeat(60));
  console.log(`Results saved to: ${outputFile}`);
  console.log('='.repeat(60));
}

// Run main function
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
