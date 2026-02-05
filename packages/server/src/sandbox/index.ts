/**
 * Sandbox execution module.
 *
 * Provides safe code execution using Node.js vm module with controlled globals.
 */

import vm from 'node:vm';
import { createCapturedConsole, createSandboxContext, formatLogs, type LogEntry } from './context.js';
import { compileTypeScript, wrapCodeForExecution } from './compiler.js';

export type { LogEntry } from './context.js';

export interface ExecuteOptions {
  /** Timeout in milliseconds (default: 5000, max: 30000) */
  timeout?: number;
  /** Whether to compile as TypeScript (default: false) */
  typescript?: boolean;
}

export interface ExecuteResult {
  success: boolean;
  /** The return value of the executed code (serialized to string) */
  result?: string;
  /** Console output captured during execution */
  logs: LogEntry[];
  /** Formatted log output as string */
  logsFormatted: string;
  /** Error message if execution failed */
  error?: string;
  /** Execution time in milliseconds */
  executionTimeMs: number;
}

const DEFAULT_TIMEOUT = 5000;
const MAX_TIMEOUT = 30000;

/**
 * Execute JavaScript or TypeScript code in a sandboxed environment.
 */
export async function executeCode(code: string, options: ExecuteOptions = {}): Promise<ExecuteResult> {
  const startTime = performance.now();
  const timeout = Math.min(options.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);

  // Compile TypeScript if needed
  let jsCode = code;
  if (options.typescript) {
    const compileResult = await compileTypeScript(code);
    if (!compileResult.success) {
      return {
        success: false,
        logs: [],
        logsFormatted: '',
        error: `Compilation failed:\n${compileResult.errors?.join('\n') ?? 'Unknown error'}`,
        executionTimeMs: performance.now() - startTime,
      };
    }
    jsCode = compileResult.code!;
  }

  // Wrap code to capture return value
  const wrappedCode = wrapCodeForExecution(jsCode);

  // Create sandboxed context
  const capturedConsole = createCapturedConsole();
  const context = createSandboxContext(capturedConsole);

  try {
    // Create and run the script
    const script = new vm.Script(wrappedCode, {
      filename: options.typescript ? 'sandbox.ts' : 'sandbox.js',
    });

    const result = script.runInContext(context, {
      timeout,
      displayErrors: true,
    });

    // Serialize the result
    let resultStr: string | undefined;
    if (result !== undefined) {
      try {
        if (typeof result === 'function') {
          resultStr = '[Function]';
        } else if (typeof result === 'symbol') {
          resultStr = result.toString();
        } else {
          resultStr = JSON.stringify(result, null, 2);
        }
      } catch {
        resultStr = String(result);
      }
    }

    return {
      success: true,
      result: resultStr,
      logs: capturedConsole.getLogs(),
      logsFormatted: formatLogs(capturedConsole.getLogs()),
      executionTimeMs: performance.now() - startTime,
    };
  } catch (err) {
    const logs = capturedConsole.getLogs();
    let errorMessage: string;

    if (err instanceof Error) {
      if (err.message.includes('Script execution timed out')) {
        errorMessage = `Execution timed out after ${timeout}ms`;
      } else {
        // Include stack trace for better debugging
        errorMessage = err.stack ?? err.message;
      }
    } else {
      errorMessage = String(err);
    }

    return {
      success: false,
      logs,
      logsFormatted: formatLogs(logs),
      error: errorMessage,
      executionTimeMs: performance.now() - startTime,
    };
  }
}

/**
 * Execute JavaScript code in a sandboxed environment.
 */
export function executeJs(code: string, options: Omit<ExecuteOptions, 'typescript'> = {}): Promise<ExecuteResult> {
  return executeCode(code, { ...options, typescript: false });
}

/**
 * Execute TypeScript code in a sandboxed environment.
 */
export function executeTs(code: string, options: Omit<ExecuteOptions, 'typescript'> = {}): Promise<ExecuteResult> {
  return executeCode(code, { ...options, typescript: true });
}
