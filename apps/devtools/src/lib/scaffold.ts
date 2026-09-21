export {};

/**
 * What `createProject` writes into a new sandbox.
 *
 * Pure string building, kept out of `services/projects.ts` so it can be read and
 * tested on its own; it is the pattern most new apps copy.
 *
 * It follows the App Authoring Contract the compiler generates and the app-agent
 * prompt embeds: one `export default defineApp({...})`, no `render()` call, no
 * mount lookup.
 */

/**
 * A deployable app id derived from a project name.
 *
 * Must satisfy deploy's own rule (`/^[a-z][a-z0-9-]*$/`) or the eventual deploy is
 * refused — and it goes in app.json now, where the compiler checks `defineApp({ id })`
 * against it on every build, so an id that could never deploy would fail much later
 * and somewhere else.
 */
export function appIdFromName(name: string, projectId: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // A name that is entirely non-ASCII slugifies to nothing, and one starting with a
  // digit ("2048") is a legal name but not a legal id. Both get a prefix, not a rejection.
  if (!slug) return `app-${projectId}`;
  return /^[a-z]/.test(slug) ? slug : `app-${slug}`;
}

/**
 * `src/main.ts` for a new project.
 *
 * It declares one state key and one command with a Zod `params`. The JSON-Schema form
 * validates presence and unknown keys but not declared *types*, so a `type: "string"`
 * param accepts the number 12345; a Zod schema validates it.
 *
 * The two are only compatible because the `` html`` `` template lives inside `App()`.
 * A Zod `params` makes the compiler import the app to read the schema back, in a
 * worker with a stubbed DOM; a template evaluated at *module scope* builds a
 * `<template>` element on import and dies there, taking the whole manifest with it.
 * Hoisting the template out of the function would break every new project.
 */
export function scaffoldMain(name: string, appId: string): string {
  // `\${...}` is a literal Solid interpolation in the generated file, not one here.
  return `import { createSignal } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { defineApp } from '@bundled/yaar';
import * as z from '@bundled/zod';
import './styles.css';

// Zod Mini ships without message text, so a wrong type reads only "Invalid input".
// Loading the English locale makes it "expected number, received string".
z.config(z.locales.en());

const [count, setCount] = createSignal(0);

function App() {
  return html\`
    <div class="y-app y-p-3">
      <h1>Hello, ${name}!</h1>
      <button class="y-btn y-btn-primary" onClick=\${() => setCount(count() + 1)}>
        Clicked \${count} times
      </button>
    </div>\`;
}

// One default export, and the SDK does the rest: registration at module scope,
// mounting into the wrapper's only mount point, and the error contract. Never call
// render() or getElementById here — see the App Authoring Contract.
export default defineApp({
  // Must equal "appId" in app.json. The build compares them.
  id: '${appId}',
  name: '${name}',
  state: {
    count: {
      description: 'How many times the button has been clicked',
      get: () => count(),
    },
  },
  commands: {
    add: {
      description: 'Add to the counter',
      // A Zod schema, not a JSON Schema literal: this one actually checks that
      // \`by\` is a number. \`run\` receives the parsed value.
      params: z.object({ by: z.optional(z.number()) }),
      // This command accumulates, so replaying it when the iframe remounts would
      // count twice. Reads and idempotent setters can leave \`replay\` off.
      replay: 'never',
      run: (p) => {
        setCount(count() + (p.by ?? 1));
        return { count: count() };
      },
    },
  },
  view: App,
});
`;
}
