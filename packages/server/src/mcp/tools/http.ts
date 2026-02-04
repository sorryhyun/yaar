/**
 * HTTP tools - GET and POST requests using curl for cross-platform compatibility.
 * curl is available by default on Windows 10+, macOS, and Linux.
 *
 * Includes domain allowlist security feature:
 * - Requests are only allowed to domains in curl_allowed_domains.yaml
 * - Use request_allowing_domain tool to ask user permission to add new domains
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ok } from '../utils.js';
import { configRead, configWrite } from '../../storage/index.js';
import { actionEmitter } from '../action-emitter.js';

const execFileAsync = promisify(execFile);

// Chrome-like User-Agent for better compatibility
const CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const ALLOWED_DOMAINS_FILE = 'curl_allowed_domains.yaml';

interface AllowedDomainsConfig {
  allowed_domains: string[];
}

interface CurlResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Extract domain from URL.
 */
function extractDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return '';
  }
}

/**
 * Read allowed domains from storage.
 */
async function readAllowedDomains(): Promise<string[]> {
  const result = await configRead(ALLOWED_DOMAINS_FILE);
  if (!result.success || !result.content) {
    // Create default config with empty list
    const defaultConfig: AllowedDomainsConfig = { allowed_domains: [] };
    await configWrite(ALLOWED_DOMAINS_FILE, stringifyYaml(defaultConfig));
    return [];
  }

  try {
    const config = parseYaml(result.content) as AllowedDomainsConfig;
    return config.allowed_domains || [];
  } catch {
    return [];
  }
}

/**
 * Add a domain to the allowed list.
 */
async function addAllowedDomain(domain: string): Promise<boolean> {
  const domains = await readAllowedDomains();
  if (domains.includes(domain)) {
    return true; // Already allowed
  }

  domains.push(domain);
  const config: AllowedDomainsConfig = { allowed_domains: domains };
  const result = await configWrite(ALLOWED_DOMAINS_FILE, stringifyYaml(config));
  return result.success;
}

/**
 * Check if a domain is allowed.
 */
async function isDomainAllowed(domain: string): Promise<boolean> {
  const allowed = await readAllowedDomains();
  return allowed.includes(domain);
}

async function executeCurl(args: string[]): Promise<CurlResult> {
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
  const lines = stdout.split('\n');
  const headers: Record<string, string> = {};
  let bodyStartIndex = 0;
  let status = 0;

  // Find the last HTTP status line (in case of redirects)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('HTTP/')) {
      const match = line.match(/HTTP\/[\d.]+ (\d+)/);
      if (match) {
        status = parseInt(match[1], 10);
      }
      // Reset headers for new response (redirect case)
      Object.keys(headers).forEach((key) => delete headers[key]);
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

export function registerHttpTools(server: McpServer): void {
  // request_allowing_domain
  server.registerTool(
    'request_allowing_domain',
    {
      description:
        'Request permission from the user to allow HTTP requests to a specific domain. Shows a confirmation dialog and if approved, adds the domain to the allowlist. Use this tool when http_get or http_post returns a domain-not-allowed error.',
      inputSchema: {
        domain: z.string().describe('The domain to request access for (e.g., "api.example.com")'),
        reason: z
          .string()
          .optional()
          .describe('Optional reason for why this domain access is needed'),
      },
    },
    async (args) => {
      // Check if already allowed
      if (await isDomainAllowed(args.domain)) {
        return ok(`Domain "${args.domain}" is already in the allowed list.`);
      }

      // Show permission dialog with "Remember my choice" option
      const reasonText = args.reason ? `\n\nReason: ${args.reason}` : '';
      const confirmed = await actionEmitter.showPermissionDialog(
        'Allow Domain Access',
        `The AI wants to make HTTP requests to "${args.domain}".${reasonText}\n\nDo you want to allow this domain?`,
        'http_domain', // toolName for permission storage
        args.domain,   // context - the specific domain
        'Allow',
        'Deny'
      );

      if (confirmed) {
        const success = await addAllowedDomain(args.domain);
        if (success) {
          return ok(`Domain "${args.domain}" has been added to the allowed list.`);
        } else {
          return ok(`Failed to add domain "${args.domain}" to the allowed list.`);
        }
      } else {
        return ok(`User denied access to domain "${args.domain}".`);
      }
    }
  );

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

        // Truncate very large responses
        const maxLength = 50000;
        let body = result.body;
        if (body.length > maxLength) {
          body = body.slice(0, maxLength) + '\n\n[Response truncated]';
        }

        // For success (2xx), just return body. For errors, include status.
        if (result.status >= 200 && result.status < 300) {
          return ok(body);
        }
        return ok(`Error ${result.status}:\n${body}`);
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

        // Truncate very large responses
        const maxLength = 50000;
        let body = result.body;
        if (body.length > maxLength) {
          body = body.slice(0, maxLength) + '\n\n[Response truncated]';
        }

        // For success (2xx), just return body. For errors, include status.
        if (result.status >= 200 && result.status < 300) {
          return ok(body);
        }
        return ok(`Error ${result.status}:\n${body}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        return ok(`Error: ${message}`);
      }
    }
  );
}
