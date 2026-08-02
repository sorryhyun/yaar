// KERNEL PART 1/11 — limits, shared run state, the AsyncFunction constructor.
// A fragment of the worker source; see ../source.ts for how the parts join and
// for the String.raw rules that apply to every one of them.
export const PRELUDE = String.raw`
var __labLIM = { maxRows: 5000, maxCellChars: 400, maxJsonBytes: 250000, maxStringChars: 200000, maxLogs: 500, maxLogChars: 4000 };
var __labS = { logs: [], parts: [], lastChart: null, pending: Object.create(null), nextCallId: 1 };
var __labAF = Object.getPrototypeOf(async function () {}).constructor;
`;