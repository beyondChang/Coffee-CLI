import type { ToolType } from '../store/app-state';

// ToolType carries a null (a session without a tool), so the pinned-card
// catalog narrows it to the concrete tool ids.
export type AgentAppKey = Exclude<ToolType, null>;

// The pinned-card catalog, in the order the tool dialog and the launchpad show
// it. Lives outside CenterPanel because the settings modal's 应用 section
// renders the same list; a regression test compares it with CenterPanel's
// rendered catalog so a tool added on one side cannot be missing on the other.
export const AGENT_APP_KEYS: AgentAppKey[] = [
  'claude', 'codex', 'dsh', 'cursor', 'copilot', 'antigravity',
  'openclaw', 'hermes', 'opencode', 'pi', 'cline', 'goose', 'aider',
  'omp', 'crush', 'qwen', 'kilo', 'kiro', 'kimicode',
  'codebuddy', 'grok', 'mimocode', 'minimax', 'muse',
  'terminal',
];
