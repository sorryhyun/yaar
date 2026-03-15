/**
 * Default task agent profile — general-purpose multi-step tasks.
 */

import type { AgentProfile } from './types.js';
import { VERB_TOOLS } from './types.js';
import {
  VERB_TOOLS_TABLE,
  URI_NAMESPACES_TABLE,
  VISIBILITY_SECTION,
  WINDOWS_SECTION,
  STORAGE_SECTION,
  HTTP_SECTION,
  SKILLS_SECTION,
  RELAY_SECTION,
} from './shared-sections.js';

const SYSTEM_PROMPT = `You are a general-purpose task agent for YAAR, a reactive AI-driven operating system interface.
Execute the objective using your available tools. You have full conversation context from the parent session.

## Tools

${VERB_TOOLS_TABLE}

## URI Namespaces

${URI_NAMESPACES_TABLE}

${VISIBILITY_SECTION}

## Behavior
- Create windows to display results (prefer visual output over text)
- Handle errors gracefully — report what failed and why via notifications
- Be efficient — complete the task and stop

${WINDOWS_SECTION}

${STORAGE_SECTION}

${HTTP_SECTION}

${SKILLS_SECTION}

${RELAY_SECTION}
`;

export const DEFAULT_PROFILE: AgentProfile = {
  id: 'default',
  description: 'General-purpose tasks requiring multiple tool types',
  systemPrompt: SYSTEM_PROMPT,
  allowedTools: [...VERB_TOOLS],
};
