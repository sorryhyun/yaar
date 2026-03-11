/**
 * HTTP request tools - http_get and http_post.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, error } from '../utils.js';
import { extractDomain, isDomainAllowed } from '../domains.js';
import { executeCurl, formatResponse, CHROME_USER_AGENT } from './curl.js';

export function registerRequestTools(server: McpServer): void {
  // http_get
  server.registerTool(
    'http_get',
    {
      description:
        "Make an HTTP GET request. Requires the domain to be in the allowed list. Use invoke('yaar://config/domains', { domain }) to allowlist a domain first.",
      inputSchema: {
        url: z.string().url().describe('The URL to fetch'),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe('Optional HTTP headers as key-value pairs'),
        followRedirects: z.boolean().optional().describe('Follow redirects (default: true)'),
      },
    },
    async (args) => {
      // Check domain allowlist
      const domain = extractDomain(args.url);
      if (!domain) {
        return error('Invalid URL');
      }

      if (!(await isDomainAllowed(domain))) {
        return error(
          `Domain "${domain}" is not in the allowed list. Use invoke('yaar://config/domains', { domain: "${domain}" }) to request access.`,
        );
      }

      try {
        const headers: Record<string, string> = {
          'User-Agent': CHROME_USER_AGENT,
          ...args.headers,
        };

        const result = await executeCurl(args.url, {
          headers,
          followRedirects: args.followRedirects !== false,
        });
        return ok(formatResponse(result));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return error(message);
      }
    },
  );

  // http_post
  server.registerTool(
    'http_post',
    {
      description:
        "Make an HTTP POST request. Requires the domain to be in the allowed list. Use invoke('yaar://config/domains', { domain }) to allowlist a domain first.",
      inputSchema: {
        url: z.string().url().describe('The URL to send the request to'),
        body: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .optional()
          .describe('Request body - either a string or JSON object'),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe('Optional HTTP headers as key-value pairs'),
        contentType: z
          .enum(['json', 'form', 'text'])
          .optional()
          .describe(
            'Content type: json (application/json), form (application/x-www-form-urlencoded), or text (text/plain). Defaults to json.',
          ),
        followRedirects: z.boolean().optional().describe('Follow redirects (default: true)'),
      },
    },
    async (args) => {
      // Check domain allowlist
      const domain = extractDomain(args.url);
      if (!domain) {
        return error('Invalid URL');
      }

      if (!(await isDomainAllowed(domain))) {
        return error(
          `Domain "${domain}" is not in the allowed list. Use invoke('yaar://config/domains', { domain: "${domain}" }) to request access.`,
        );
      }

      try {
        const contentType = args.contentType || 'json';
        const headers: Record<string, string> = {
          'User-Agent': CHROME_USER_AGENT,
          ...args.headers,
        };

        let requestBody: string | undefined;

        if (args.body !== undefined) {
          switch (contentType) {
            case 'json':
              headers['Content-Type'] = 'application/json';
              requestBody = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
              break;
            case 'form':
              headers['Content-Type'] = 'application/x-www-form-urlencoded';
              if (typeof args.body === 'object') {
                requestBody = new URLSearchParams(args.body as Record<string, string>).toString();
              } else {
                requestBody = args.body;
              }
              break;
            case 'text':
              headers['Content-Type'] = 'text/plain';
              requestBody = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
              break;
          }
        }

        const result = await executeCurl(args.url, {
          method: 'POST',
          headers,
          body: requestBody,
          followRedirects: args.followRedirects !== false,
        });
        return ok(formatResponse(result));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return error(message);
      }
    },
  );
}
