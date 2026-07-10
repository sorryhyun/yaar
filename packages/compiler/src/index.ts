export { initCompiler, getCompilerConfig, type CompilerConfig } from './config.js';
export {
  getSandboxDir,
  getSandboxPath,
  compileTypeScript,
  generateHtmlWrapper,
  type CompileOptions,
  type CompileResult,
} from './compile.js';
export { typecheckSandbox, type TypecheckResult } from './typecheck.js';
export {
  BUNDLED_LIBRARIES,
  getAvailableBundledLibraries,
  getBundledLibraryDetail,
  bundledLibraryPluginBun,
  cssFilePlugin,
  solidHtmlClosingTagPlugin,
  solidHtmlTemplateGuardPlugin,
} from './plugins.js';
export {
  classifyTemplate,
  scanSource,
  formatFindings,
  type SolidHtmlDefect,
  type SolidHtmlDefectKind,
  type SolidHtmlFinding,
} from './solid-html-guard.js';
export { extractProtocolFromSource } from './extract-protocol.js';
export { YAAR_DESIGN_TOKENS_CSS } from './design-tokens.js';
export {
  isAppStale,
  writeBuildManifest,
  readBuildManifest,
  computeSourceHash,
  computeAppJsonHash,
  COMPILER_VERSION,
  type BuildManifest,
} from './build-manifest.js';
