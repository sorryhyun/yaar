/**
 * HTTP request execution and response formatting utilities.
 *
 * Uses native fetch() instead of shelling out to curl.
 */

import { validateUrl, safeFetch } from '../../lib/ssrf.js';

// Chrome-like User-Agent for better compatibility
export const CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export interface CurlResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  followRedirects?: boolean;
  timeout?: number;
}

export async function executeCurl(url: string, options: RequestOptions = {}): Promise<CurlResult> {
  const { method = 'GET', headers = {}, body, followRedirects = true, timeout = 30000 } = options;

  validateUrl(url); // Throws if private/invalid

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = followRedirects
      ? await safeFetch(url, { method, headers, body, signal: controller.signal })
      : await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'manual' });

    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });

    const responseBody = await res.text();

    return {
      status: res.status,
      headers: responseHeaders,
      body: responseBody,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Request timed out');
    }
    const message = err instanceof Error ? err.message : 'Unknown error';
    throw new Error(`Request failed: ${message}`);
  } finally {
    clearTimeout(timer);
  }
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
  const isHtml =
    result.headers['content-type']?.includes('text/html') ||
    body.trimStart().startsWith('<!DOCTYPE') ||
    body.trimStart().startsWith('<html');
  if (isHtml) {
    // Extract text content from HTML, collapse whitespace
    const text = body
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
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
