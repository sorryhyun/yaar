/**
 * HTTP request tools - http_get and http_post.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok } from '../utils.js';
import { extractDomain, isDomainAllowed } from '../domains.js';
import { executeCurl, formatResponse, CHROME_USER_AGENT } from './curl.js';

export function registerRequestTools(server: McpServer): void {
  // http_get
  server.registerTool(
    'http_get',
    {
      description:
        'Make an HTTP GET request using curl. Requires the domain to be in the allowed list. Use request_allowing_domain first if needed.',
      inputSchema: {
        url: z.string().url().describe('The URL to fetch'),
        headers: z
          .record(z.string(), z.string())
          .optional()
          .describe('Optional HTTP headers as key-value pairs'),
        followRedirects: z
          .boolean()
          .optional()
          .describe('Follow redirects (default: true)'),
      },
    },
    async (args) => {
      // Check domain allowlist
      const domain = extractDomain(args.url);
      if (!domain) {
        return ok('Error: Invalid URL');
      }

      if (!(await isDomainAllowed(domain))) {
        return ok(
          `Error: Domain "${domain}" is not in the allowed list. Use request_allowing_domain tool first to request access.`
        );
      }

      try {
        const curlArgs = [
          '-s', // Silent mode (no progress)
          '-S', // Show errors even in silent mode
          '-i', // Include headers in output
          '-A',
          CHROME_USER_AGENT,
          '--max-time',
          '30',
        ];

        if (args.followRedirects !== false) {
          curlArgs.push('-L'); // Follow redirects
        }

        // Add custom headers
        if (args.headers) {
          for (const [key, value] of Object.entries(args.headers)) {
            curlArgs.push('-H', `${key}: ${value}`);
          }
        }

        curlArgs.push(args.url);

        const result = await executeCurl(curlArgs);
        return ok(formatResponse(result));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return ok(`Error: ${message}`);
      }
    }
  );

  // http_post
  server.registerTool(
    'http_post',
    {
      description:
        'Make an HTTP POST request using curl. Requires the domain to be in the allowed list. Use request_allowing_domain first if needed.',
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
            'Content type: json (application/json), form (application/x-www-form-urlencoded), or text (text/plain). Defaults to json.'
          ),
        followRedirects: z
          .boolean()
          .optional()
          .describe('Follow redirects (default: true)'),
      },
    },
    async (args) => {
      // Check domain allowlist
      const domain = extractDomain(args.url);
      if (!domain) {
        return ok('Error: Invalid URL');
      }

      if (!(await isDomainAllowed(domain))) {
        return ok(
          `Error: Domain "${domain}" is not in the allowed list. Use request_allowing_domain tool first to request access.`
        );
      }

      try {
        const contentType = args.contentType || 'json';
        const curlArgs = [
          '-s', // Silent mode (no progress)
          '-S', // Show errors even in silent mode
          '-i', // Include headers in output
          '-X',
          'POST',
          '-A',
          CHROME_USER_AGENT,
          '--max-time',
          '30',
        ];

        if (args.followRedirects !== false) {
          curlArgs.push('-L'); // Follow redirects
        }

        // Set content type and body
        if (args.body !== undefined) {
          let requestBody: string;

          switch (contentType) {
            case 'json':
              curlArgs.push('-H', 'Content-Type: application/json');
              requestBody =
                typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
              break;
            case 'form':
              curlArgs.push('-H', 'Content-Type: application/x-www-form-urlencoded');
              if (typeof args.body === 'object') {
                requestBody = new URLSearchParams(
                  args.body as Record<string, string>
                ).toString();
              } else {
                requestBody = args.body;
              }
              break;
            case 'text':
              curlArgs.push('-H', 'Content-Type: text/plain');
              requestBody =
                typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
              break;
          }

          curlArgs.push('-d', requestBody);
        }

        // Add custom headers
        if (args.headers) {
          for (const [key, value] of Object.entries(args.headers)) {
            curlArgs.push('-H', `${key}: ${value}`);
          }
        }

        curlArgs.push(args.url);

        const result = await executeCurl(curlArgs);
        return ok(formatResponse(result));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return ok(`Error: ${message}`);
      }
    }
  );
}
