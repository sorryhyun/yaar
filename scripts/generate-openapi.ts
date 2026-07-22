/**
 * Generate OpenAPI 3.1 YAML spec from all route files' PUBLIC_ENDPOINTS.
 *
 * Usage: bun run scripts/generate-openapi.ts
 * Output: docs/reference/openapi.yaml
 */

import { readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import type { EndpointMeta } from '../packages/server/src/http/utils.js';

// Import PUBLIC_ENDPOINTS from all route files
import { PUBLIC_ENDPOINTS as API_PUBLIC } from '../packages/server/src/http/routes/api.js';
import { PUBLIC_ENDPOINTS as AUTH_PUBLIC } from '../packages/server/src/http/routes/auth.js';
import { PUBLIC_ENDPOINTS as BRIDGE_PUBLIC } from '../packages/server/src/http/routes/bridge.js';
import { PUBLIC_ENDPOINTS as BROWSER_PUBLIC } from '../packages/server/src/http/routes/browser.js';
import { PUBLIC_ENDPOINTS as DEV_PUBLIC } from '../packages/server/src/http/routes/dev.js';
import { PUBLIC_ENDPOINTS as FILES_PUBLIC } from '../packages/server/src/http/routes/files.js';
import { PUBLIC_ENDPOINTS as ML_RUNTIME_PUBLIC } from '../packages/server/src/http/routes/ml-runtime.js';
import { PUBLIC_ENDPOINTS as PROXY_PUBLIC } from '../packages/server/src/http/routes/proxy.js';
import { PUBLIC_ENDPOINTS as SESSIONS_PUBLIC } from '../packages/server/src/http/routes/sessions.js';
import { PUBLIC_ENDPOINTS as SETTINGS_PUBLIC } from '../packages/server/src/http/routes/settings.js';
import { PUBLIC_ENDPOINTS as SHORTCUTS_PUBLIC } from '../packages/server/src/http/routes/shortcuts.js';
import { PUBLIC_ENDPOINTS as VERB_PUBLIC } from '../packages/server/src/http/routes/verb.js';

const ALL_ENDPOINTS: EndpointMeta[] = [
  ...API_PUBLIC,
  ...AUTH_PUBLIC,
  ...BRIDGE_PUBLIC,
  ...BROWSER_PUBLIC,
  ...DEV_PUBLIC,
  ...FILES_PUBLIC,
  ...ML_RUNTIME_PUBLIC,
  ...PROXY_PUBLIC,
  ...SESSIONS_PUBLIC,
  ...SETTINGS_PUBLIC,
  ...SHORTCUTS_PUBLIC,
  ...VERB_PUBLIC,
];

// Guard: every route file (except index.ts/static.ts, which don't export
// PUBLIC_ENDPOINTS) must be represented above, or new routes silently
// vanish from the generated spec.
const WIRED_ROUTE_FILES = new Set([
  'api.ts',
  'auth.ts',
  'bridge.ts',
  'browser.ts',
  'dev.ts',
  'files.ts',
  'ml-runtime.ts',
  'proxy.ts',
  'sessions.ts',
  'settings.ts',
  'shortcuts.ts',
  'verb.ts',
]);
const SKIPPED_ROUTE_FILES = new Set(['index.ts', 'static.ts']);
const routesDir = join(import.meta.dir, '..', 'packages', 'server', 'src', 'http', 'routes');
const actualRouteFiles = readdirSync(routesDir).filter((f) => f.endsWith('.ts'));
const unwired = actualRouteFiles.filter(
  (f) => !WIRED_ROUTE_FILES.has(f) && !SKIPPED_ROUTE_FILES.has(f),
);
if (unwired.length > 0) {
  console.error(
    `generate-openapi: found route file(s) not wired into ALL_ENDPOINTS: ${unwired.join(', ')}\n` +
      `Add a PUBLIC_ENDPOINTS import for each and list it in WIRED_ROUTE_FILES.`,
  );
  process.exit(1);
}

/** Escape a YAML string value — wrap in quotes if it contains special chars. */
function yamlString(s: string): string {
  if (/[:#\[\]{}&*!|>'"%@`,?]/.test(s) || s.includes('\n') || s.trim() !== s) {
    return JSON.stringify(s);
  }
  return s;
}

/** Convert EndpointMeta path params (:id, {id}) to OpenAPI format ({id}). */
function toOpenApiPath(path: string): string {
  // Strip query string portion
  const pathOnly = path.split('?')[0];
  // Convert :param to {param}
  return pathOnly.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '{$1}');
}

/** Extract path parameter names from an OpenAPI-style path. */
function extractPathParams(openApiPath: string): string[] {
  const params: string[] = [];
  const regex = /\{([^}]+)\}/g;
  let match;
  while ((match = regex.exec(openApiPath)) !== null) {
    params.push(match[1]);
  }
  return params;
}

function generateSpec(): string {
  const lines: string[] = [];

  lines.push('openapi: "3.1.0"');
  lines.push('info:');
  lines.push('  title: YAAR Server API');
  lines.push('  description: REST API for the YAAR reactive AI interface server.');
  lines.push('  version: 0.1.0');
  lines.push('servers:');
  lines.push('  - url: http://localhost:8000');
  lines.push('    description: Local development server');
  lines.push('paths:');

  // Group endpoints by path, deduplicating same method+path (e.g. GET with ?query variants)
  const byPath = new Map<string, EndpointMeta[]>();
  for (const ep of ALL_ENDPOINTS) {
    const openApiPath = toOpenApiPath(ep.path);
    if (!byPath.has(openApiPath)) {
      byPath.set(openApiPath, []);
    }
    const group = byPath.get(openApiPath)!;
    const existing = group.find((e) => e.method === ep.method);
    if (existing) {
      // Merge descriptions for same method+path (e.g. GET with/without ?list=true)
      existing.description += ` / ${ep.description}`;
    } else {
      group.push({ ...ep, path: openApiPath });
    }
  }

  // Sort paths for stable output
  const sortedPaths = [...byPath.keys()].sort();

  for (const path of sortedPaths) {
    lines.push(`  ${path}:`);
    const endpoints = byPath.get(path)!;
    const pathParams = extractPathParams(path);

    // If there are path parameters, declare them at the path level
    if (pathParams.length > 0) {
      lines.push('    parameters:');
      for (const param of pathParams) {
        lines.push(`      - name: ${param}`);
        lines.push('        in: path');
        lines.push('        required: true');
        lines.push('        schema:');
        lines.push('          type: string');
      }
    }

    for (const ep of endpoints) {
      const method = ep.method.toLowerCase();
      lines.push(`    ${method}:`);
      lines.push(`      summary: ${yamlString(ep.description)}`);
      lines.push('      responses:');
      lines.push('        "200":');
      lines.push(`          description: ${yamlString(ep.response)}`);
      lines.push('          content:');
      lines.push('            application/json:');
      lines.push('              schema:');
      lines.push('                type: object');
    }
  }

  return lines.join('\n') + '\n';
}

const spec = generateSpec();
const outPath = join(import.meta.dir, '..', 'docs', 'reference', 'openapi.yaml');
writeFileSync(outPath, spec, 'utf-8');
console.log(`OpenAPI spec written to ${outPath} (${ALL_ENDPOINTS.length} endpoints)`);
