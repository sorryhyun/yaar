// Boundary schemas for the three verb-API list responses this app renders.
//
// `yaar://session/agents`, `yaar://windows` and `yaar://apps` all cross a trust
// boundary: they are served by the running YAAR server, whose version need not
// match this app's, and the last two return *either* a direct record or a
// `resource_link` (`{ uri, name, description }`) depending on the verb layer's
// mood. That two-shaped response is exactly what used to be duck-typed with
// `entry: any` heuristics — these schemas make the discrimination explicit and
// make a shape we cannot read a *logged* skip rather than a silent `as` cast
// that blows up later in the renderer.
//
// Every object is loose so an additive server field does not fail the read (the
// adapters below rebuild explicit records, so it is not carried into the UI —
// nothing here is persisted, so there is no round-trip to survive), and only
// the fields the app actually reads are validated. Fields the UI already
// guards with `?? 0` / `?? []` stay optional here and are defaulted by the
// adapters below, so an older server that omits a counter degrades to a zero in
// one cell instead of dropping the whole roster.
//
// `@bundled/zod` is Zod Mini (functional API): `z.optional(z.string())`,
// `z.safeParse(Schema, data)`. Mini tree-shakes to ~10KB; standard Zod would
// add ~260KB.
import * as z from '@bundled/zod';

// The verb layer's generic list entry. `uri` is where the id is encoded and
// `name` is the display label, so both are required — an entry missing either
// is not renderable. The absence of an `id` is what distinguishes a link from a
// direct record (see `asResourceLink`), so it is spelled out in the schema
// rather than left to a caller's `&& !entry.id`.
export const ResourceLinkSchema = z.looseObject({
  uri: z.string(),
  name: z.string(),
  description: z.optional(z.string()),
  id: z.optional(z.undefined()),
});

// `id` and `type` are load-bearing (the interrupt/kill target, and the filter
// that splits app agents from monitor agents), so a row without them is
// rejected — and rejected on its own: the adapter parses rows one at a time, so
// one unreadable agent costs that agent, not the roster and not the counters
// beside it. `label`/`busy` are defaulted by the adapter — a missing label is a
// cosmetic degradation, not a reason to hide a live agent.
//
// `type` is `z.string()`, not a union of the four tiers this app knows about,
// for the same reason: the server owns that vocabulary and may grow a fifth
// tier, and a value we do not recognise still names a real, killable agent. The
// renderer already falls back to a neutral badge colour for an unknown tier.
const AgentUsageSchema = z.looseObject({
  inputTokens: z.optional(z.number()),
  outputTokens: z.optional(z.number()),
  // Not optional decoration — see AgentUsage in types.ts. Under prompt caching
  // these carry the input side almost entirely, and `inputTokens` alone is ~10.
  cacheReadTokens: z.optional(z.number()),
  cacheWriteTokens: z.optional(z.number()),
});

export const AgentEntrySchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  label: z.optional(z.string()),
  busy: z.optional(z.boolean()),
  monitorId: z.optional(z.string()),
  appId: z.optional(z.string()),
  usage: z.optional(AgentUsageSchema),
});

export const AgentStatsSchema = z.looseObject({
  totalAgents: z.optional(z.number()),
  idleAgents: z.optional(z.number()),
  busyAgents: z.optional(z.number()),
  monitorAgents: z.optional(z.number()),
  appAgents: z.optional(z.number()),
  ephemeralAgents: z.optional(z.number()),
  sessionAgent: z.optional(z.boolean()),
  usage: z.optional(AgentUsageSchema),
  // Rows stay `unknown` here and are parsed one by one against
  // AgentEntrySchema in the adapter. Validating them as part of the envelope
  // would make a single malformed row reject the whole response — blanking the
  // roster *and* the summary counters, which are perfectly readable.
  agents: z.optional(z.array(z.unknown())),
});

// `id` is required: it is the close target and the join key against agents.
// Everything else is display-only and defaulted.
export const WindowInfoSchema = z.looseObject({
  id: z.string(),
  uri: z.optional(z.string()),
  title: z.optional(z.string()),
  position: z.optional(z.string()),
  size: z.optional(z.string()),
  renderer: z.optional(z.string()),
  locked: z.optional(z.boolean()),
  lockedBy: z.optional(z.string()),
  appId: z.optional(z.string()),
});

// The installed-app roster is used for display names only, so `name` is
// defaulted from the id when absent.
export const InstalledAppSchema = z.looseObject({
  id: z.string(),
  name: z.optional(z.string()),
  description: z.optional(z.string()),
});

// A browser session. `id` and `state` are load-bearing — the first is the
// revive/kill target, the second decides which button the row offers — so a row
// without either is dropped. Everything else is display and is defaulted by the
// adapter, on the same "an older server omitting a field must not blank the
// list" principle as the schemas above.
export const BrowserSessionSchema = z.looseObject({
  id: z.string(),
  state: z.string(),
  url: z.optional(z.string()),
  title: z.optional(z.string()),
  mobile: z.optional(z.boolean()),
  windowId: z.optional(z.string()),
  driving: z.optional(z.boolean()),
  viewers: z.optional(z.number()),
  createdAt: z.optional(z.number()),
  idleMs: z.optional(z.number()),
  jsHeapBytes: z.optional(z.nullable(z.number())),
});

// The envelope `list('yaar://system/browsers')` returns. Rows stay `unknown` and
// are parsed one at a time, for the reason spelled out on AgentStatsSchema.
export const BrowserListSchema = z.looseObject({
  chromeRunning: z.optional(z.boolean()),
  maxSessions: z.optional(z.number()),
  sessions: z.optional(z.array(z.unknown())),
});
