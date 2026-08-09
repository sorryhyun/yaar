export {};

// Barrel for the service layer: everything that performs I/O or mutates signals.
// Re-exports only what this directory owns — never a UI module.
//
// ./preview and ./manifest were absent through Phases 1–2: both imported the
// temporary top-level compat barrel (../project), and listing them here would have
// closed a cycle (project.ts -> services/index.ts -> services/preview.ts -> project.ts).
// Phase 3 deleted that barrel and pointed them at core/ and their siblings, so they
// belong here now like any other service.

export * from './fs-walk';
export * from './changes';
export * from './files';
export * from './projects';
export * from './console';
export * from './grep';
export * from './build';
export * from './git';
export * from './libraries';
export * from './preview';
export * from './manifest';
