# URL Status Checker

A Playwright-based script that checks any number of URLs to determine website status. The script categorizes websites into: `5xx`, `404`, `Parked`, `Broken`, `ok`, or `Other`.

## Status Categories

- **5xx**: Website Down / Not Loading / Time Out (with automatic retries)
- **404**: Website loads but home page is "not found"
- **Parked**: Blank page or Hosting page or On Sale
- **Broken**: Website loads but clearly broken or Under construction
- **ok**: Website loads fine
- **Other**: Other cases

## Prerequisites

1. **Node.js** (v18 or higher)
3. **Input CSV file** with a "Domain" column containing the URLs to check

## Installation

From the project root directory (`W:\playwright_Projects\go_through_2000_links`):

```bash
npm install
npx playwright install chromium
```

## Input CSV Format

Your input CSV file should have a column named `Domain` (case-insensitive). The script also accepts `domain`, `URL`, or `url` as column names.

Example `input.csv`:
```csv
Domain
example.com
https://example.org
www.example.net
```

## Usage

### Basic Usage

From the project root directory:

```bash
npm run build
npm start
```

This will:
- Read URLs from `input.csv` (default)
- Save results to `output.csv` (default)
- Use concurrency of 4 (3-5 parallel checks)

### Custom Input/Output Files

```bash
npm run build
node dist/check-urls.js path/to/your/input.csv path/to/output.csv
```

### Custom Concurrency

```bash
npm run build
node dist/check-urls.js input.csv output.csv 5
```

The third parameter sets the number of parallel checks (default: 4, recommended: 3-5).

### One-Command Build and Run

```bash
npm run check
```

## Output Format

The script generates a CSV file with the following columns:

- **Domain**: The checked URL
- **Status**: One of `5xx`, `404`, `Parked`, `Broken`, `ok`, or `Other`
- **Timestamp**: ISO timestamp of when the check was performed
- **Notes**: Additional information about the status (HTTP codes, error messages, etc.)

Example output:
```csv
Domain,Status,Timestamp,Notes
https://example.com,ok,2024-01-15T10:30:00.000Z,Website loads fine
https://broken-site.com,Broken,2024-01-15T10:30:05.000Z,Under construction detected
https://down-site.com,5xx,2024-01-15T10:30:10.000Z,HTTP 500 after 3 attempts
```

## Features

### Retry Logic
- Automatically retries up to 3 times for 5xx errors and network timeouts
- Uses exponential backoff: 1s, 2s, 4s delays between retries
- Helps distinguish temporary outages from permanent failures

### Status Detection
- **HTTP Status Codes**: Detects 5xx and 4xx errors
- **Content Analysis**: Analyzes page content to detect parked domains, broken pages, etc.
- **Parked Detection**: Identifies blank pages, hosting provider pages, "for sale" indicators
- **Broken Detection**: Identifies "under construction", error messages, broken layouts

### Concurrency Control
- Processes 3-5 URLs in parallel (configurable)
- Prevents overwhelming the system while maintaining reasonable speed
- Default: 4 parallel checks

### Error Handling
- Handles malformed URLs gracefully
- 30-second timeout per page load
- Comprehensive error messages in output
- Continues processing even if individual URLs fail

## Performance

For ~2000 URLs:
- With concurrency of 4: Approximately 8-12 hours (depending on response times)
- Each URL check takes 5-30 seconds (including retries if needed)
- Progress is displayed in real-time

## Important Notes

1. **Rate Limiting**: The script uses low concurrency (3-5) to avoid overwhelming servers. If you encounter rate limiting, reduce the concurrency.

2. **Timeouts**: Each page has a 30-second timeout. Slow-loading pages will timeout and be marked appropriately.

3. **Retries**: 5xx errors and network timeouts are automatically retried up to 3 times with exponential backoff.

4. **CSV Import**: After the script completes, you can import the `output.csv` file into Google Sheets for further analysis.

## Troubleshooting

### "Input file not found"
- Make sure your CSV file exists in the project directory
- Or provide the full path: `node dist/check-urls.js /full/path/to/input.csv`

### "No valid URLs found"
- Check that your CSV has a column named `Domain`, `domain`, `URL`, or `url`
- Ensure the URLs are in the correct column

### Browser installation issues
- Run: `npx playwright install chromium`
- On Windows, you may need to run PowerShell as Administrator

## Project Structure

```
go_through_2000_links/
├── package.json          # Project dependencies
├── tsconfig.json         # TypeScript configuration
├── check-urls.ts         # Main script
├── status-detector.ts    # Status detection logic
├── README.md             # This file
├── input.csv             # Input file (create this)
├── output.csv            # Output file (generated)
├── dist/                 # Compiled JavaScript (generated)
└── node_modules/         # Dependencies (generated)
```

## License

ISC
