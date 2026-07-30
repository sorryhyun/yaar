export {};

/**
 * What `createProject` writes into a new sandbox.
 *
 * Pure string building, kept out of `services/projects.ts` so it can be read (and
 * tested) as what it is: the first thing every author of a YAAR app sees, and
 * therefore the pattern most of them will copy.
 *
 * It follows the App Authoring Contract the compiler generates and the app-agent
 * prompt embeds — one `export default defineApp({...})`, no `render()` call, no
 * mount lookup. The previous scaffold contradicted all three, so the very first
 * compile taught the opposite of the rules the same session had just been given,
 * and any project that needed a protocol had to be rewritten from scratch before
 * it could declare one.
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
  // digit ("2048") is a legal name but not a legal id. Both get a prefix rather than
  // a rejection: naming the project is not the moment to argue about id syntax.
  if (!slug) return `app-${projectId}`;
  return /^[a-z]/.test(slug) ? slug : `app-${slug}`;
}

/**
 * `src/main.ts` for a new project.
 *
 * Deliberately more than "hello world": it declares one state key and one command
 * with a Zod `params`, because those are the two things a scaffold can demonstrate
 * that documentation cannot. The Zod schema in particular is the fix for a trap the
 * JSON-Schema form leaves open — presence and unknown keys are validated, declared
 * *types* are not, so a `type: "string"` param accepts the number 12345 and stores
 * it. An app that starts from a validating schema never meets that.
 */
export function scaffoldMain(name: string, appId: string): string {
  // `\${...}` is a literal Solid interpolation in the generated file, not one here.
  return `import { createSignal } from '@bundled/solid-js';
import html from '@bundled/solid-js/html';
import { defineApp } from '@bundled/yaar';
import * as z from '@bundled/zod';
import './styles.css';

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
