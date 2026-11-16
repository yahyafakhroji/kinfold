// One table of hook runtime specs, keyed by agent id. An agent whose adapter
// has not landed maps to null; the hook command then captures nothing for it.

import { CLAUDE_CODE_EVENTS, CLAUDE_CODE_HOST, normalizeClaudeCode, userPromptContextOutput } from '../adapters/claude-code'
import { normalizeCodex } from '../adapters/codex'
import { ampMessageOutput, normalizeAmp } from '../adapters/amp'
import { normalizeAuggie } from '../adapters/auggie'
import { normalizeCrush } from '../adapters/crush'
import { normalizeGoose } from '../adapters/goose'
import { injectStepsOutput, normalizeAntigravity } from '../adapters/antigravity'
import { contextModificationOutput, normalizeCline } from '../adapters/cline'
import { normalizeKimiCode } from '../adapters/kimi-code'
import { normalizeKiroWith } from '../adapters/kiro'
import { normalizeCursor } from '../adapters/cursor'
import { normalizeClaudeStyle } from './families/claude-style-parse'
import { GEMINI_CLI_EVENTS, normalizeGeminiStyle } from './families/gemini-style-parse'
import type { HookHostSpec } from './hook-spec'
import type { AgentId } from './profile'

/** Claude Code and Codex share the hookSpecificOutput shape; Cursor's sessionStart reads additional_context. */
const hookSpecific = (text: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })

/**
 * `systemMessage` beside whatever the hook already prints. Claude Code, Codex,
 * Gemini CLI, Qwen Code, Factory Droid, Junie and Auggie each document it as
 * text shown to the user and kept out of the model's context (checked
 * 2026-11-15); Codex and Droid style it as a warning. Every one of them prints
 * a JSON object, so the message is one more key on it.
 */
const withSystemMessage = (output: string | null, message: string): string =>
  JSON.stringify({ systemMessage: message, ...(output === null ? {} : (JSON.parse(output) as Record<string, unknown>)) })

/**
 * Devin runs Claude Code's user hooks too, and sets DEVIN_PROJECT_DIR for every
 * hook it runs (docs.devin.ai/cli/extensibility/hooks/overview, 2026-11-13).
 * The docs don't scope the variable to hook processes, so Claude Code started
 * from a Devin terminal could inherit it. Claude Code sends transcript_path on
 * every payload (every recorded fixture has it) and Devin documents none, so a
 * payload carrying it stays Claude Code's whatever the environment says.
 */
export const DEVIN_HOOK_ENV = 'DEVIN_PROJECT_DIR'
const claudeCaller = (payload: unknown, env: NodeJS.ProcessEnv): AgentId | null => {
  const value = env[DEVIN_HOOK_ENV]
  if (typeof value !== 'string' || value === '') return null
  if (typeof payload !== 'object' || payload === null || Object.hasOwn(payload, 'transcript_path')) return null
  return 'devin'
}

const CLAUDE_CODE_SPEC: HookHostSpec = {
  normalize: normalizeClaudeCode,
  sessionContext: hookSpecific,
  promptContext: userPromptContextOutput,
  userMessage: withSystemMessage,
  callerOf: claudeCaller,
}

// Codex documents the same UserPromptSubmit hookSpecificOutput shape as Claude Code.
const CODEX_SPEC: HookHostSpec = {
  normalize: normalizeCodex, sessionContext: hookSpecific,
  promptContext: userPromptContextOutput, userMessage: withSystemMessage,
}

const CURSOR_SPEC: HookHostSpec = {
  normalize: normalizeCursor,
  sessionContext: (text) => JSON.stringify({ additional_context: text }),
}

// The Claude-style agents below are built from their docs (2026-11-13); each
// fires Claude Code's event names, and their output shapes are the ones each
// profile's comment cites.
const CLAUDE_STYLE_EVENTS = CLAUDE_CODE_EVENTS

/** Factory Droid, Junie and Devin document no PostToolUseFailure. */
const { PostToolUseFailure: _noFailureEvent, ...WITHOUT_FAILURE_EVENT } = CLAUDE_STYLE_EVENTS

/**
 * Qwen Code, Droid and Devin take Claude Code's hookSpecificOutput lines on
 * both events. Qwen and Droid also document systemMessage; Devin's docs don't
 * say, so it gets none until a live run shows what it does with one.
 */
function claudeShapedSpec(normalize: HookHostSpec['normalize'], userChannel: boolean): HookHostSpec {
  return {
    normalize, sessionContext: hookSpecific, promptContext: userPromptContextOutput,
    ...(userChannel ? { userMessage: withSystemMessage } : {}),
  }
}

/** Junie and Copilot read a top-level additionalContext. */
const topLevelContext = (text: string): string => JSON.stringify({ additionalContext: text })

// Junie ignores additionalContext on SessionStart and prepends it on UserPromptSubmit.
const JUNIE_SPEC: HookHostSpec = {
  normalize: normalizeClaudeStyle(WITHOUT_FAILURE_EVENT, 'junie'),
  sessionContext: topLevelContext,
  sessionContextIgnored: true,
  promptContext: topLevelContext,
  userMessage: withSystemMessage,
}

// Copilot drops command-hook output on UserPromptSubmit; sessionStart reads a top-level additionalContext.
// What Kinfold recalled reaches the user through a progress line: Copilot CLI
// takes every stdout line of the form {"type":"progress","message":...} out of
// a hook's output before the model sees it and shows the message as an info
// row; its docs call these lines "display-only". Built from Copilot's source
// (1.0.60), not tested live. The update notice stays where it was, in the
// context, since a line nobody has seen on screen is no place for news.
const COPILOT_SPEC: HookHostSpec = {
  normalize: normalizeClaudeStyle(CLAUDE_STYLE_EVENTS, 'copilot'),
  sessionContext: topLevelContext,
  progressLine: (message) => JSON.stringify({ type: 'progress', message }),
}

// Gemini CLI reads hookSpecificOutput.additionalContext on SessionStart and
// BeforeAgent (geminicli.com/docs/hooks/reference, 2026-11-13).
const GEMINI_CLI_SPEC: HookHostSpec = {
  normalize: normalizeGeminiStyle(GEMINI_CLI_EVENTS, 'gemini-cli'),
  sessionContext: hookSpecific,
  promptContext: (text) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'BeforeAgent', additionalContext: text } }),
  userMessage: withSystemMessage,
}

// Antigravity reads injectSteps on SessionStart (antigravity.google/docs/hooks.md,
// 2026-11-13). PreInvocation takes them too, but which PreInvocation starts
// each prompt is unchecked (see profiles/antigravity.ts), so prompts get none.
const ANTIGRAVITY_SPEC: HookHostSpec = {
  normalize: normalizeAntigravity,
  sessionContext: injectStepsOutput,
}

// Cline's VS Code extension reads contextModification on UserPromptSubmit.
// It may run TaskStart on every turn (see profiles/cline.ts), so a session
// start asks for no pack until a live run shows it fires once per task.
const CLINE_SPEC: HookHostSpec = {
  normalize: normalizeCline,
  sessionContext: contextModificationOutput,
  sessionContextIgnored: true,
  promptContext: contextModificationOutput,
}

// Kiro's docs confirm no hook output reaching the agent on SessionStart or
// UserPromptSubmit, so its hook asks for and prints no context. The prompt
// is read from USER_PROMPT, which Kiro sets for the hook process.
const KIRO_SPEC: HookHostSpec = {
  normalize: normalizeKiroWith(() => process.env.USER_PROMPT),
  sessionContext: (text) => text,
  sessionContextIgnored: true,
}

// Amp's plugin returns the message as agent.start's result; the session-start
// pack waits in the plugin for the thread's first agent.start.
const AMP_SPEC: HookHostSpec = {
  normalize: normalizeAmp,
  sessionContext: ampMessageOutput,
  promptContext: ampMessageOutput,
  // The plugin hands `notify` to ctx.ui.notify, a notification Amp shows the user and keeps out of the thread.
  userMessage: (output, message) => JSON.stringify({ ...(output === null ? {} : (JSON.parse(output) as Record<string, unknown>)), notify: message }),
}

// Kimi Code appends a UserPromptSubmit hook's plain stdout to the context and
// drops what SessionStart prints.
const KIMI_CODE_SPEC: HookHostSpec = {
  normalize: normalizeKimiCode,
  sessionContext: (text) => text,
  sessionContextIgnored: true,
  promptContext: (text) => text,
}

// Auggie, Goose and Crush document no hook output reaching the model at
// session start or on a prompt (see each profile), so their hook captures
// and hands the model nothing. Auggie does show the user a systemMessage, so
// it alone prints one.
function captureOnlySpec(normalize: HookHostSpec['normalize'], userChannel = false): HookHostSpec {
  return {
    normalize, sessionContext: (text) => text, sessionContextIgnored: true,
    ...(userChannel ? { userMessage: withSystemMessage } : {}),
  }
}

export const HOOK_SPECS: Readonly<Record<AgentId, HookHostSpec | null>> = {
  [CLAUDE_CODE_HOST]: CLAUDE_CODE_SPEC,
  codex: CODEX_SPEC,
  cursor: CURSOR_SPEC,
  opencode: null,
  'gemini-cli': GEMINI_CLI_SPEC,
  'qwen-code': claudeShapedSpec(normalizeClaudeStyle(CLAUDE_STYLE_EVENTS, 'qwen-code'), true),
  'factory-droid': claudeShapedSpec(normalizeClaudeStyle(WITHOUT_FAILURE_EVENT, 'factory-droid'), true),
  devin: claudeShapedSpec(normalizeClaudeStyle(WITHOUT_FAILURE_EVENT, 'devin'), false),
  'kilo-code': null,
  cline: CLINE_SPEC,
  copilot: COPILOT_SPEC,
  antigravity: ANTIGRAVITY_SPEC,
  junie: JUNIE_SPEC,
  kiro: KIRO_SPEC,
  amp: AMP_SPEC,
  'kimi-code': KIMI_CODE_SPEC,
  auggie: captureOnlySpec(normalizeAuggie, true),
  goose: captureOnlySpec(normalizeGoose),
  crush: captureOnlySpec(normalizeCrush),
  zed: null,
  continue: null,
  warp: null,
}

export function hookSpecFor(id: AgentId): HookHostSpec | null {
  return HOOK_SPECS[id]
}
