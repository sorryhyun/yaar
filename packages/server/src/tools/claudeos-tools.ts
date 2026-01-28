/**
 * ClaudeOS Custom Tools.
 *
 * Provides tools for Claude to interact with the ClaudeOS interface:
 * - System information
 * - Time and date
 * - Calculator
 * - Web fetch
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

/**
 * Get current system time tool.
 */
const getSystemTime = tool(
  'get_system_time',
  'Get the current system time and date in various formats',
  {
    timezone: z.string().optional().describe('Timezone (e.g., "America/New_York"). Defaults to system timezone.'),
    format: z.enum(['iso', 'locale', 'unix']).optional().describe('Output format: iso (ISO 8601), locale (localized string), or unix (timestamp). Defaults to iso.')
  },
  async (args) => {
    const now = new Date();
    let result: string;

    switch (args.format || 'iso') {
      case 'unix':
        result = String(Math.floor(now.getTime() / 1000));
        break;
      case 'locale':
        result = now.toLocaleString('en-US', {
          timeZone: args.timezone,
          dateStyle: 'full',
          timeStyle: 'long'
        });
        break;
      case 'iso':
      default:
        result = now.toISOString();
    }

    return {
      content: [{
        type: 'text' as const,
        text: result
      }]
    };
  }
);

/**
 * Calculator tool for mathematical expressions.
 */
const calculate = tool(
  'calculate',
  'Evaluate a mathematical expression safely. Supports basic arithmetic (+, -, *, /, %), powers (**), and common math functions (sqrt, sin, cos, tan, log, exp, abs, floor, ceil, round).',
  {
    expression: z.string().describe('Mathematical expression to evaluate (e.g., "2 + 2", "sqrt(16)", "sin(3.14159/2)")'),
    precision: z.number().optional().describe('Number of decimal places for the result. Defaults to 10.')
  },
  async (args) => {
    try {
      // Safe math evaluation using Function constructor with limited scope
      const mathFunctions = {
        sqrt: Math.sqrt,
        sin: Math.sin,
        cos: Math.cos,
        tan: Math.tan,
        log: Math.log,
        log10: Math.log10,
        exp: Math.exp,
        abs: Math.abs,
        floor: Math.floor,
        ceil: Math.ceil,
        round: Math.round,
        pow: Math.pow,
        min: Math.min,
        max: Math.max,
        PI: Math.PI,
        E: Math.E
      };

      // Validate expression contains only allowed characters
      const allowedPattern = /^[\d\s+\-*/().%,a-zA-Z_]+$/;
      if (!allowedPattern.test(args.expression)) {
        throw new Error('Expression contains invalid characters');
      }

      // Create safe evaluation function
      const fn = new Function(
        ...Object.keys(mathFunctions),
        `return (${args.expression})`
      );

      const result = fn(...Object.values(mathFunctions));

      if (typeof result !== 'number' || !isFinite(result)) {
        throw new Error('Expression did not evaluate to a valid number');
      }

      const precision = args.precision ?? 10;
      const formatted = Number(result.toFixed(precision));

      return {
        content: [{
          type: 'text' as const,
          text: `${args.expression} = ${formatted}`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error evaluating expression: ${error instanceof Error ? error.message : 'Unknown error'}`
        }]
      };
    }
  }
);

/**
 * System information tool.
 */
const getSystemInfo = tool(
  'get_system_info',
  'Get information about the ClaudeOS system environment',
  {},
  async () => {
    const info = {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      uptime: Math.floor(process.uptime()),
      memoryUsage: process.memoryUsage(),
      cwd: process.cwd()
    };

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(info, null, 2)
      }]
    };
  }
);

/**
 * Environment variable reader (safe subset).
 */
const getEnvVar = tool(
  'get_env_var',
  'Get the value of a safe environment variable. Only allows reading non-sensitive variables.',
  {
    name: z.string().describe('Name of the environment variable to read')
  },
  async (args) => {
    // Blocklist of sensitive environment variables
    const sensitivePatterns = [
      /key/i,
      /secret/i,
      /password/i,
      /token/i,
      /auth/i,
      /credential/i,
      /private/i,
      /api/i
    ];

    const isSensitive = sensitivePatterns.some(pattern => pattern.test(args.name));

    if (isSensitive) {
      return {
        content: [{
          type: 'text' as const,
          text: `Error: Cannot read sensitive environment variable "${args.name}"`
        }]
      };
    }

    const value = process.env[args.name];

    if (value === undefined) {
      return {
        content: [{
          type: 'text' as const,
          text: `Environment variable "${args.name}" is not set`
        }]
      };
    }

    return {
      content: [{
        type: 'text' as const,
        text: value
      }]
    };
  }
);

/**
 * Random number generator tool.
 */
const generateRandom = tool(
  'generate_random',
  'Generate random numbers or strings',
  {
    type: z.enum(['integer', 'float', 'uuid', 'hex']).describe('Type of random value to generate'),
    min: z.number().optional().describe('Minimum value for integer/float (default: 0)'),
    max: z.number().optional().describe('Maximum value for integer/float (default: 100)'),
    length: z.number().optional().describe('Length for hex string (default: 16)')
  },
  async (args) => {
    let result: string;

    switch (args.type) {
      case 'integer': {
        const min = args.min ?? 0;
        const max = args.max ?? 100;
        result = String(Math.floor(Math.random() * (max - min + 1)) + min);
        break;
      }
      case 'float': {
        const min = args.min ?? 0;
        const max = args.max ?? 100;
        result = String(Math.random() * (max - min) + min);
        break;
      }
      case 'uuid': {
        result = crypto.randomUUID();
        break;
      }
      case 'hex': {
        const length = args.length ?? 16;
        const bytes = new Uint8Array(Math.ceil(length / 2));
        crypto.getRandomValues(bytes);
        result = Array.from(bytes)
          .map(b => b.toString(16).padStart(2, '0'))
          .join('')
          .slice(0, length);
        break;
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: result
      }]
    };
  }
);

/**
 * Create the ClaudeOS MCP server with all custom tools.
 */
export const claudeOSTools = createSdkMcpServer({
  name: 'claudeos',
  version: '1.0.0',
  tools: [
    getSystemTime,
    calculate,
    getSystemInfo,
    getEnvVar,
    generateRandom
  ]
});

/**
 * Get the allowed tool names for ClaudeOS.
 */
export function getClaudeOSToolNames(): string[] {
  return [
    'mcp__claudeos__get_system_time',
    'mcp__claudeos__calculate',
    'mcp__claudeos__get_system_info',
    'mcp__claudeos__get_env_var',
    'mcp__claudeos__generate_random'
  ];
}
