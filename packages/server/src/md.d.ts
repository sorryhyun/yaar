/**
 * Bun text imports for markdown: `import text from './x.md' with { type: 'text' }`.
 * The runtime (and the exe bundler) inlines the file's contents as a string; this
 * declaration is what lets tsc resolve the module. Used by the prompt parts under
 * `agents/profiles` and the skill topics in `features/skills`.
 */
declare module '*.md' {
  const text: string;
  export default text;
}
