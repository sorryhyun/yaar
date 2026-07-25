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
  GATED_BUNDLED_LIBRARIES,
  getAvailableBundledLibraries,
  getBundledLibraryDetail,
  bundledLibraryPluginBun,
  cssFilePlugin,
  solidHtmlSourcePlugin,
} from './plugins.js';
export {
  classifyTemplate,
  scanSource,
  formatFindings,
  type SolidHtmlDefect,
  type SolidHtmlDefectKind,
  type SolidHtmlFinding,
} from './solid-html-guard.js';
export {
  APP_MOUNT_ID,
  scanMountTargets,
  formatMountFindings,
  type MountFinding,
} from './mount-guard.js';
export {
  knownTokens,
  suggestToken,
  scanTokens,
  formatTokenFindings,
  type AppSourceFile,
  type TokenFinding,
} from './design-token-guard.js';
export {
  extractProtocolFromModules,
  formatProtocolError,
  type AstProtocolExtraction,
  type ExtractOptions,
  type ProtocolError,
  type ReadFile,
} from './extract-protocol-ast.js';
export {
  extractProtocolFromDir,
  type DirExtraction,
  type DirExtractOptions,
} from './extract-protocol-dir.js';
export { loadTypeScript } from './load-typescript.js';
export { YAAR_DESIGN_TOKENS_CSS, describeDesignTokens } from './design-tokens.js';
export {
  isAppStale,
  writeBuildManifest,
  readBuildManifest,
  computeSourceHash,
  computeAppJsonHash,
  COMPILER_VERSION,
  type BuildManifest,
} from './build-manifest.js';
