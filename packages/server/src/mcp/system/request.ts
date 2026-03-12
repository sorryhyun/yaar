/**
 * Unified HTTP request tool — supports GET, POST, PUT, PATCH, DELETE.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, error } from '../../handlers/utils.js';
import { extractDomain, isDomainAllowed } from '../../features/config/domains.js';
import { executeCurl, formatResponse, CHROME_USER_AGENT } from './curl.js';

export function registerRequestTools(server: McpServer): void {
  server.registerTool(
    'http',
    {
      description:
        "Make an HTTP request. Requires the domain to be in the allowed list. Use invoke('yaar://config/domains', { domain }) to allowlist a domain first.",
      inputSchema: {
        url: z.string().url().describe('The URL to send the request to'),
        method: z
          .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
          .optional()
          .describe('HTTP method (default: GET)'),
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
        const method = args.method || 'GET';
        const headers: Record<string, string> = {
          'User-Agent': CHROME_USER_AGENT,
          ...args.headers,
        };

        let requestBody: string | undefined;

        if (args.body !== undefined) {
          const contentType = args.contentType || 'json';
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
          method,
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
