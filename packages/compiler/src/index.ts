export { initCompiler, getCompilerConfig, type CompilerConfig } from './config.js';
export {
  getSandboxDir,
  getSandboxPath,
  compileTypeScript,
  generateHtmlWrapper,
  type CompileOptions,
  type CompileResult,
} from './compile.js';
export { typecheckSandbox, type TypecheckOptions, type TypecheckResult } from './typecheck.js';
export {
  BUNDLED_LIBRARIES,
  BUNDLED_SHIMS,
  GATED_BUNDLED_LIBRARIES,
  getAvailableBundledLibraries,
  resolveBrowserEntry,
  toForwardSlash,
} from './bundled/registry.js';
export { getBundledLibraryDetail, getDescribableLibraries } from './bundled/describe-library.js';
export {
  ASSET_MIME_TYPES,
  bundledLibraryPluginBun,
  cssFilePlugin,
  assetDataUrlPlugin,
  solidHtmlSourcePlugin,
} from './bundled/plugins.js';
// The exe's per-library build. `scripts/build/prebundle-libs.js` and the completeness
// test both go through here, so the module can move without touching either.
export {
  prebundleLibrary,
  resolvePrebundleEntrypoint,
  solidExternals,
} from './bundled/prebundle.js';
export {
  classifyTemplate,
  scanSource,
  formatFindings,
  type SolidHtmlDefect,
  type SolidHtmlDefectKind,
  type SolidHtmlFinding,
} from './guards/solid-html-guard.js';
export {
  APP_MOUNT_ID,
  scanMountTargets,
  formatMountFindings,
  type MountFinding,
} from './guards/mount-guard.js';
export {
  knownTokens,
  suggestToken,
  scanTokens,
  formatTokenFindings,
  type AppSourceFile,
  type TokenFinding,
} from './guards/design-token-guard.js';
export {
  APP_REGISTER_REMOVED_MESSAGE,
  extractProtocolFromModules,
  formatProtocolError,
  type AstProtocolExtraction,
  type ExtractOptions,
  type ProtocolError,
  type ReadFile,
} from './protocol/extract-protocol-ast.js';
export {
  extractProtocolFromDir,
  type DirExtraction,
  type DirExtractOptions,
} from './protocol/extract-protocol-dir.js';
export { loadTypeScript } from './load-typescript.js';
export {
  YAAR_DESIGN_TOKENS_CSS,
  describeDesignTokens,
  describeDesignTokensBrief,
} from './design-tokens.js';
export {
  isAppStale,
  writeBuildManifest,
  readBuildManifest,
  computeSourceHash,
  computeAppJsonHash,
  COMPILER_VERSION,
  type BuildManifest,
} from './build/build-manifest.js';
