export {};

// Barrel for the core layer. Re-exports ONLY what this directory owns —
// never a service, never a UI module. That restraint is the whole point:
// the old src/project.ts barrel re-exported across layer boundaries, which is
// why `import { compileStatus } from './project'` was possible and misleading.

export * from './types';
export * from './store';
