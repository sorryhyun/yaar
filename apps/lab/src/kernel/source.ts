// The compute kernel. This string is turned into a Blob and run as a classic Web Worker.
//
// IMPORTANT: every part below is a String.raw template literal, so each part body
// must contain NO backticks and NO dollar-brace sequences. Backslashes survive
// verbatim (that is why String.raw is used), so regexes can be written normally.
// Everything in the parts is plain ES2020 JS, NOT type checked. See AGENTS.md.
//
// The parts are concatenated with join(''), and each one after the first begins
// with the newline that follows its opening backtick — that newline IS the blank
// separator line between sections. So a part must start at its section banner and
// end at its last non-blank line. Adding a stray blank line at the top or bottom of
// a part shifts every line number the kernel reports in a stack trace.
//
// Order is load-bearing: the worker is one flat scope evaluated top to bottom, and
// RUN_LOOP must stay last because it closes over everything and posts 'ready'.

import { PRELUDE } from './source/prelude';
import { FORMAT } from './source/format';
import { CSV } from './source/csv';
import { STATS } from './source/stats';
import { DF } from './source/df';
import { STORE } from './source/store';
import { PLOT } from './source/plot';
import { ENCODE } from './source/encode';
import { AGENT_RESULT } from './source/agent-result';
import { TRANSFORM } from './source/transform';
import { RUN_LOOP } from './source/run-loop';

export const KERNEL_SRC = [
  PRELUDE,
  FORMAT,
  CSV,
  STATS,
  DF,
  STORE,
  PLOT,
  ENCODE,
  AGENT_RESULT,
  TRANSFORM,
  RUN_LOOP,
].join('');
