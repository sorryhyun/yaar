/**
 * HTTP permission tool - request_allowing_domain.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, error } from '../utils.js';
import { actionEmitter } from '../action-emitter.js';
import { addAllowedDomain, isDomainAllowed } from '../domains.js';

export function registerPermissionTools(server: McpServer): void {
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
        args.domain, // context - the specific domain
        'Allow',
        'Deny',
      );

      if (confirmed) {
        const success = await addAllowedDomain(args.domain);
        if (success) {
          return ok(`Domain "${args.domain}" has been added to the allowed list.`);
        } else {
          return error(`Failed to add domain "${args.domain}" to the allowed list.`);
        }
      } else {
        return error(`User denied access to domain "${args.domain}".`);
      }
    },
  );
}
