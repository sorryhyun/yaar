/**
 * uuid shim — works around a Bun bundler defect on pure re-export barrels.
 *
 * uuid's browser entry (`dist/index.js`) is nothing but
 * `export { default as v4 } from './v4.js'` lines. Bundling that file directly
 * makes Bun emit the `export { ... }` statement with every imported binding
 * dropped, producing a module whose exports reference undeclared identifiers:
 *
 *   uuid:1:8: "h" is not declared in this file
 *
 * The bundle still *builds*, so the breakage only surfaces later, when an app
 * that imports `@bundled/uuid` is compiled against the prebundled artifact
 * (exe mode). Importing the bindings first and re-exporting them separately
 * gives the bundler real references to follow, so the implementations survive.
 */
import {
  MAX,
  NIL,
  parse,
  stringify,
  v1,
  v1ToV6,
  v3,
  v4,
  v5,
  v6,
  v6ToV1,
  v7,
  validate,
  version,
} from 'uuid';

export { MAX, NIL, parse, stringify, v1, v1ToV6, v3, v4, v5, v6, v6ToV1, v7, validate, version };
