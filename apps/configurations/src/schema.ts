// Boundary schemas for the `yaar://config/*` payloads this app edits.
//
// These come from YAAR's own config files on disk — hand-editable, written by
// older builds, and shared with the rest of the OS. That makes them persisted
// external input, not values this app just produced: a truncated or renamed
// record must be distinguishable from an empty one, which is exactly the
// distinction `loadConfigList` could not make while it collapsed everything to
// `[]`.
//
// Every object is loose and only the fields the views actually read are
// required, so an added config key never fails a load.
//
// `@bundled/zod` is Zod Mini (functional API): `z.optional(z.string())`,
// `z.looseObject({...})`, `z.safeParse(Schema, data)`. Mini tree-shakes to ~10KB;
// standard Zod would add ~260KB.
import * as z from '@bundled/zod';

// yaar://config/shortcuts → { shortcuts: [...] }. The list renders `label`/`icon`
// and navigates to `target`; `id` is the delete key. Everything else is optional.
export const ShortcutSchema = z.looseObject({
  id: z.string(),
  label: z.string(),
  icon: z.string(),
  iconType: z.optional(z.string()),
  target: z.string(),
  folderId: z.optional(z.string()),
  createdAt: z.optional(z.number()),
});

// yaar://config/domains → { allow_all_domains, allowed_domains }. Both fields are
// read directly by the view — the toggle reads the boolean, the list maps the
// array — and `read()` can also resolve to null when the config is absent, which
// used to be assigned straight into the signal and crash the first render on
// `data().allow_all_domains`.
export const DomainsDataSchema = z.looseObject({
  allow_all_domains: z.boolean(),
  allowed_domains: z.array(z.string()),
});

// yaar://config/hooks → { hooks: [...] }.
//
// Both nested shapes are deliberately permissive, because the *server* owns them
// and grows them independently of this editor. Checked against
// `packages/server/src/features/config/hooks.ts`:
//
//   - every `HookFilter` field is `string | string[]`, not `string`;
//   - `HookAction.payload` is `string` for `type: 'interaction'` and
//     `OSAction | OSAction[]` for `type: 'os_action'` — never a plain record.
//
// So `payload` is `unknown`: the view only renders it (and already guards with
// `action.type === 'os_action' && action.payload`), it does not interpret it.
// Narrowing either of these to `z.string()` / `z.record(...)` rejects hooks the
// server writes routinely — see the per-entry recovery in `api.ts` for why that
// used to be able to blank the whole list.
const HookFilterFieldSchema = z.optional(z.union([z.string(), z.array(z.string())]));

const HookFilterSchema = z.looseObject({
  verb: HookFilterFieldSchema,
  uri: HookFilterFieldSchema,
  action: HookFilterFieldSchema,
  toolName: HookFilterFieldSchema,
});

const HookActionSchema = z.looseObject({
  type: z.string(),
  payload: z.optional(z.unknown()),
});

export const HookSchema = z.looseObject({
  id: z.string(),
  event: z.string(),
  filter: z.optional(HookFilterSchema),
  action: HookActionSchema,
  label: z.string(),
  enabled: z.boolean(),
  createdAt: z.optional(z.string()),
});
