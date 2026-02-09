/**
 * Curl execution and response formatting utilities.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Chrome-like User-Agent for better compatibility
export const CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface CurlResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export async function executeCurl(args: string[]): Promise<CurlResult> {
  let stdout: string;

  try {
    const result = await execFileAsync('curl', args, {
      maxBuffer: 10 * 1024 * 1024, // 10MB max
      timeout: 30000, // 30 second timeout
    });
    stdout = result.stdout;
  } catch (error) {
    // execFile throws on non-zero exit code
    const execError = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
      signal?: string;
      message?: string;
    };

    // If we got some stdout (e.g., HTTP error response), try to use it
    if (execError.stdout) {
      stdout = execError.stdout;
      // Continue to parse the response even though curl returned non-zero
    } else {
      // No stdout means curl itself failed (network error, etc.)
      // Build a detailed error message
      const parts: string[] = [];

      if (execError.stderr && execError.stderr.trim()) {
        parts.push(execError.stderr.trim());
      }

      if (execError.code !== undefined) {
        // curl exit codes: 6=couldn't resolve host, 7=couldn't connect, 28=timeout, etc.
        parts.push(`exit code ${execError.code}`);
      }

      if (execError.killed) {
        parts.push('process was killed');
      }

      if (execError.signal) {
        parts.push(`signal: ${execError.signal}`);
      }

      const errorDetail = parts.length > 0 ? parts.join(', ') : 'Unknown error';
      throw new Error(`curl failed: ${errorDetail}`);
    }
  }

  // Parse the response (we use -i to include headers, then -w for status code)
  // With -L (follow redirects), curl outputs all intermediate responses.
  // We need to find the LAST HTTP status line and parse from there.
  const lines = stdout.split('\n');
  const headers: Record<string, string> = {};
  let bodyStartIndex = 0;
  let status = 0;

  // First pass: find the index of the last HTTP status line
  let lastStatusIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('HTTP/')) {
      lastStatusIndex = i;
    }
  }

  // Second pass: parse status, headers, and body from the last response
  for (let i = lastStatusIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('HTTP/')) {
      const match = line.match(/HTTP\/[\d.]+ (\d+)/);
      if (match) {
        status = parseInt(match[1], 10);
      }
      continue;
    }
    if (line === '') {
      bodyStartIndex = i + 1;
      break;
    }
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim().toLowerCase();
      const value = line.slice(colonIndex + 1).trim();
      headers[key] = value;
    }
  }

  const body = lines.slice(bodyStartIndex).join('\n');

  return { status, headers, body };
}

/**
 * Format the HTTP response for returning to the agent.
 * - Success (2xx): return body as-is (truncated if too large)
 * - Error: strip HTML to avoid dumping massive pages, include status code
 */
export function formatResponse(result: CurlResult): string {
  const maxLength = 50000;
  let body = result.body;

  if (result.status >= 200 && result.status < 300) {
    if (body.length > maxLength) {
      body = body.slice(0, maxLength) + '\n\n[Response truncated]';
    }
    return body;
  }

  // For error responses, strip HTML to avoid wasting tokens on full pages
  const isHtml = result.headers['content-type']?.includes('text/html') || body.trimStart().startsWith('<!DOCTYPE') || body.trimStart().startsWith('<html');
  if (isHtml) {
    // Extract text content from HTML, collapse whitespace
    const text = body.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    body = text.slice(0, 500) || `(HTML error page)`;
  } else if (body.length > maxLength) {
    body = body.slice(0, maxLength) + '\n\n[Response truncated]';
  }

  return `Error ${result.status}:\n${body}`;
}
