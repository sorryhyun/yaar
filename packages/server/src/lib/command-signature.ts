/**
 * How a protocol command's declared params are stated to a reader.
 *
 * One renderer, three readers. The app agent's prompt has rendered signatures since
 * `readFile({ paths: [...] })` was guessed against a command whose batch form is
 * `path: string[]`; `describe` and `list` on a window sub-path answered with the
 * schema or with nothing, so the *spelling* of the payload had to be inferred from
 * prose. The prose in question — "the payload IS its params" — is exactly what makes
 * a command whose own schema declares a param named `params` unreadable, and no
 * amount of rewording fixes a sentence that has to be applied to a name it collides
 * with. An example carrying the literal keys does.
 *
 * Lives in `lib/` because it reads a JSON Schema fragment and returns a string:
 * no session, no registry, nothing to inject.
 *
 * Every renderer takes the manifest's `$defs` as a trailing optional argument. A
 * param whose schema the compiler hoisted arrives as `{"$ref": "#/$defs/x"}`, and a
 * ref rendered without the table is `any` — a signature that quietly says less than
 * the one it replaced. Optional because a caller holding a descriptor and no manifest
 * (a test, an app that shares nothing) still renders exactly what it used to.
 */

import { resolveRef, type SchemaDefs } from './schema-refs.js';

export type { SchemaDefs };

/** The JSON Schema shape these renderers read — the `params` of one protocol command. */
interface ParamsSchema {
  properties?: Record<string, unknown>;
  required?: unknown;
  additionalProperties?: unknown;
}

/**
 * The three payload keys `invoke('…/commands/{key}')` reads as OS-level rather than as
 * params: two are refused, one is consumed as the transport deadline.
 *
 * Declared here rather than at the one call site because the *reason* a describe carries
 * a collision note and the reason an invoke has to check the schema are the same reason.
 */
export const RESERVED_COMMAND_KEYS = ['action', 'params', 'timeoutMs'] as const;

function paramsOf(descriptor: unknown, defs?: SchemaDefs): ParamsSchema | undefined {
  const declared = (descriptor as { params?: unknown } | undefined)?.params;
  // The dedup pass never hoists a descriptor's top-level schema — the iframe bridge
  // reads `properties`/`required` off it — so this hop is for a hand-authored
  // protocol.json that points its `params` at a def of its own.
  const schema = resolveRef(declared, defs);
  return schema && typeof schema === 'object' ? (schema as ParamsSchema) : undefined;
}

/** A parameter's declared type, rendered the way a signature reads it. */
export function renderType(prop: unknown, defs?: SchemaDefs): string {
  const resolved = resolveRef(prop, defs);
  if (!resolved || typeof resolved !== 'object') return 'any';
  const p = resolved as {
    type?: string | string[];
    enum?: unknown[];
    items?: unknown;
    oneOf?: unknown[];
    anyOf?: unknown[];
  };

  // An enum is the one case where the values matter more than the type: a param
  // documented as `string` when only three strings are accepted invites a fourth.
  if (Array.isArray(p.enum) && p.enum.length) {
    const shown = p.enum.slice(0, 6).map((v) => JSON.stringify(v));
    return shown.join('|') + (p.enum.length > 6 ? '|...' : '');
  }

  const union = p.oneOf ?? p.anyOf;
  if (Array.isArray(union) && union.length) {
    return [...new Set(union.map((member) => renderType(member, defs)))].join('|');
  }

  if (Array.isArray(p.type)) return p.type.join('|');
  if (p.type === 'array') return p.items ? `${renderType(p.items, defs)}[]` : 'array';
  return p.type ?? 'any';
}

/**
 * A command rendered as a call signature: `readFile(path: string|string[], lineNum?: boolean)`.
 *
 * The app agent's manifest used to carry names and descriptions only, while the params
 * JSON Schema lived behind a `describe` call — and devtools' prompt tells its agent that
 * this manifest *is* the full list, so a param name had to be guessed or paid for with a
 * round-trip. It got guessed, and cost a turn and an error. A signature is a fraction of
 * the schema's size and answers the two questions that were being guessed — what is this
 * called, and what shape is it.
 */
export function renderSignature(name: string, descriptor: unknown, defs?: SchemaDefs): string {
  const schema = paramsOf(descriptor, defs);
  const props = schema?.properties;
  // No declared params is not the same as "takes none" — say nothing rather than
  // render `name()` and turn an undocumented command into a documented empty one.
  if (!props || typeof props !== 'object') return name;

  const required = new Set(Array.isArray(schema?.required) ? (schema.required as string[]) : []);
  const parts = Object.entries(props).map(
    ([key, prop]) => `${key}${required.has(key) ? '' : '?'}: ${renderType(prop, defs)}`,
  );
  if (schema?.additionalProperties === true) parts.push('...');
  return `${name}(${parts.join(', ')})`;
}

/** The param names one command declares. Empty when it declares no schema at all. */
export function declaredParamNames(descriptor: unknown, defs?: SchemaDefs): string[] {
  const props = paramsOf(descriptor, defs)?.properties;
  return props && typeof props === 'object' ? Object.keys(props) : [];
}

/** The reserved keys this command declares as params of its own — usually none. */
export function reservedParamsOf(descriptor: unknown, defs?: SchemaDefs): string[] {
  const declared = new Set(declaredParamNames(descriptor, defs));
  return RESERVED_COMMAND_KEYS.filter((key) => declared.has(key));
}

/**
 * The one line that removes the ambiguity: this command, called through its sub-path URI,
 * with its own param names in the payload.
 *
 * Rendered rather than described, because the sentence that describes it ("the payload
 * *is* `params`") reads as a prohibition on a payload containing a key called `params` —
 * which is precisely the shape `setGeometryParams(id, params, points)` requires.
 */
export function renderInvokeExample(uri: string, descriptor: unknown, defs?: SchemaDefs): string {
  const payload = renderPayloadExample(descriptor, defs);
  return payload ? `invoke("${uri}", ${payload})` : `invoke("${uri}")`;
}

/**
 * Just the payload object of that example — `{ id: <string>, to?: <vec3> }` — or null for
 * a command that declares no params.
 *
 * Split out because the same command is called through two different vocabularies and
 * only the verb differs: the verbs door says `invoke("yaar://windows/…", …)`, an app agent
 * says `command("name", …)`. Sharing the payload rather than the whole line is what keeps
 * a third caller from inventing a third spelling of the literal keys.
 */
export function renderPayloadExample(descriptor: unknown, defs?: SchemaDefs): string | null {
  const schema = paramsOf(descriptor, defs);
  const props = schema?.properties;
  if (!props || typeof props !== 'object' || !Object.keys(props).length) return null;

  const required = new Set(Array.isArray(schema?.required) ? (schema.required as string[]) : []);
  const parts = Object.entries(props).map(
    ([key, prop]) => `${key}${required.has(key) ? '' : '?'}: <${renderType(prop, defs)}>`,
  );
  if (schema?.additionalProperties === true) parts.push('...');
  return `{ ${parts.join(', ')} }`;
}

/**
 * The note a command earns by declaring a key the sub-path spelling would otherwise
 * claim. Null for every command that declares none, which is nearly all of them.
 */
export function reservedKeyNote(descriptor: unknown, defs?: SchemaDefs): string | null {
  const collisions = reservedParamsOf(descriptor, defs);
  if (!collisions.length) return null;
  const names = collisions.map((k) => `\`${k}\``).join(' and ');
  return (
    `${names} ${collisions.length > 1 ? 'are params of this command' : 'is a param of this command'}, ` +
    'not a wrapper and not transport — pass it inline in the payload like any other param.'
  );
}
