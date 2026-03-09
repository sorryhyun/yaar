/**
 * Browser tools: screenshot, extract — reading page content.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ok, okWithImages } from '../../utils.js';
import { resolveSession, findMainContent } from '../../../features/browser/shared.js';

export function registerContentTools(server: McpServer): void {
  server.registerTool(
    'screenshot',
    {
      description:
        'Get the current page screenshot as an image. Optionally specify a region to magnify (4x zoom) for closer inspection of small elements.',
      inputSchema: {
        x0: z.number().optional().describe('Left edge of the region in pixels'),
        y0: z.number().optional().describe('Top edge of the region in pixels'),
        x1: z.number().optional().describe('Right edge of the region in pixels'),
        y1: z.number().optional().describe('Bottom edge of the region in pixels'),
        annotate: z
          .boolean()
          .optional()
          .describe(
            'Overlay numbered badges on interactive elements. Returns element map alongside the screenshot.',
          ),
        browserId: z
          .string()
          .optional()
          .describe('Browser ID (required if multiple browsers open)'),
      },
    },
    async (args) => {
      const session = resolveSession(args.browserId);
      const hasRegion =
        args.x0 !== undefined &&
        args.y0 !== undefined &&
        args.x1 !== undefined &&
        args.y1 !== undefined;
      const clip = hasRegion
        ? { x: args.x0!, y: args.y0!, width: args.x1! - args.x0!, height: args.y1! - args.y0! }
        : undefined;
      if (args.annotate) {
        // Inject annotations, take screenshot, then remove
        const elements = await session.annotateElements();
        const buffer = await session.screenshot(clip ? { clip } : undefined);
        await session.removeAnnotations();

        let elementMap = 'Interactive elements:';
        if (elements && elements.length > 0) {
          for (const el of elements) {
            let line = `\n  [${el.index}] <${el.tag}>`;
            if (el.text) line += ` "${el.text}"`;
            if (el.selector) line += ` selector=${el.selector}`;
            if (el.href) line += ` → ${el.href}`;
            line += ` @(${el.x},${el.y})`;
            elementMap += line;
          }
        } else {
          elementMap += '\n  (none found)';
        }

        const label = clip
          ? `Annotated magnified region (${args.x0},${args.y0})→(${args.x1},${args.y1}) @4x:`
          : 'Annotated browser screenshot:';
        return okWithImages(`${label}\n\n${elementMap}`, [
          { data: buffer.toString('base64'), mimeType: 'image/webp' },
        ]);
      }

      const buffer = await session.screenshot(clip ? { clip } : undefined);
      const label = clip
        ? `Magnified region (${args.x0},${args.y0})→(${args.x1},${args.y1}) @4x:`
        : 'Current browser screenshot:';
      return okWithImages(label, [{ data: buffer.toString('base64'), mimeType: 'image/webp' }]);
    },
  );

  server.registerTool(
    'extract',
    {
      description:
        'Extract structured content from the page: full text, links, and form fields. Optionally scope to a CSS selector.',
      inputSchema: {
        selector: z
          .string()
          .optional()
          .describe('Optional CSS selector to scope extraction (default: entire page)'),
        maxLinks: z.number().optional().describe('Max links to return (default: 50)'),
        maxTextLength: z.number().optional().describe('Max text length (default: 3000)'),
        mainContentOnly: z
          .boolean()
          .optional()
          .describe('Extract only from the largest text-containing block element'),
        browserId: z
          .string()
          .optional()
          .describe('Browser ID (required if multiple browsers open)'),
      },
    },
    async (args) => {
      const session = resolveSession(args.browserId);
      const effectiveSelector =
        args.mainContentOnly && !args.selector ? await findMainContent(session) : args.selector;
      const content = await session.extractContent(effectiveSelector);

      const maxText = args.maxTextLength ?? 3000;
      const maxLinks = args.maxLinks ?? 50;

      let result = `URL: ${content.url}\nTitle: ${content.title}\n`;

      if (content.fullText) {
        const text =
          content.fullText.length > maxText
            ? content.fullText.slice(0, maxText) + '\n... (truncated)'
            : content.fullText;
        result += `\n--- Text ---\n${text}\n`;
      }

      if (content.links.length > 0) {
        const linkLines = content.links
          .slice(0, maxLinks)
          .map((l) => `  [${l.text}](${l.href})`)
          .join('\n');
        result += `\n--- Links (${content.links.length}) ---\n${linkLines}\n`;
        if (content.links.length > maxLinks)
          result += `  ... and ${content.links.length - maxLinks} more\n`;
      }

      if (content.forms.length > 0) {
        const formLines = content.forms.map((f, i) => {
          const fields = f.fields.map((fld) => `    ${fld.name} (${fld.type})`).join('\n');
          return `  Form ${i + 1}: action=${f.action}\n${fields}`;
        });
        result += `\n--- Forms (${content.forms.length}) ---\n${formLines.join('\n')}\n`;
      }

      return ok(result.trim());
    },
  );
}
