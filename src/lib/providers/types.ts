import type { ISessionInfo, IAskUserQuestionItem } from '@/types/timeline';
import type { ITab, TPanelType, IWorkspace } from '@/types/terminal';
import type { ICurrentAction } from '@/types/status';
import type { IPermissionRequest } from '@/types/codex-permission';

export interface IAgentResumeCommandOptions {
  workspaceId?: string;
}

export interface IAgentLaunchCommandOptions {
  workspaceId?: string;
}

export interface IAgentSessionWatchOptions {
  skipInitial?: boolean;
  tmuxSession?: string;
}

export interface IAgentSessionDetectionOptions {
  allowCwdFallback?: boolean;
}

export interface ISubscription {
  stop: () => void;
}

export type ISessionWatcher = ISubscription;

export interface IAgentPreflight {
  installed: boolean;
  version: string | null;
  binaryPath: string | null;
  loggedIn: boolean;
}

export interface IAgentRuntimeSnapshot {
  idle: boolean;
  stale: boolean;
  lastAssistantSnippet: string | null;
  currentAction: ICurrentAction | null;
  reset: boolean;
  lastEntryTs: number | null;
  staleMs: number;
  interrupted: boolean;
}

export interface IAgentSessionHistoryStats {
  toolUsage: Record<string, number>;
  touchedFiles: string[];
  lastAssistantText: string | null;
  lastUserText: string | null;
  firstUserTs: number | null;
  lastAssistantTs: number | null;
  turnDurationMs: number | null;
}

export interface IAgentHookMetaPatch {
  sessionId?: string | null;
  jsonlPath?: string | null;
  lastUserMessage?: string | null;
  agentSummary?: string | null;
  clearMessages?: boolean;
  permissionRequest?: IPermissionRequest | null;
  askUserQuestionItems?: IAskUserQuestionItem[] | null;
}

export interface IAgentHookTranslation {
  meta?: IAgentHookMetaPatch;
  event?: TAgentWorkStateEvent | null;
  sessionInfo?: ISessionInfo | null;
  clearSession?: boolean;
}

/**
 * Hook-shaped event kinds delivered from the agent CLI's hook protocol.
 * Single source of truth for the Claude hook translator + status-manager dispatcher.
 */
export const HOOK_EVENT_KINDS = [
  'session-start',
  'prompt-submit',
  'notification',
  'stop',
  'interrupt',
  'pre-compact',
  'post-compact',
] as const;
export type THookEventKind = typeof HOOK_EVENT_KINDS[number];

/**
 * Standardized work-state events that providers emit. Maps to TCliState transitions:
 *  - session-start → idle
 *  - prompt-submit → busy
 *  - notification → needs-input (gated by notificationType)
 *  - stop → ready-for-review
 *  - interrupt → idle
 *  - pre-compact / post-compact → compaction state, no cliState change
 *
 * The non-hook variants (summary-update, last-user-message) originate from runtime
 * sources (pane-title polling, jsonl watcher) and never come through the hook path.
 */
export type TAgentWorkStateEvent =
  | { kind: 'session-start' }
  | { kind: 'prompt-submit' }
  | { kind: 'notification'; notificationType?: string }
  | { kind: 'stop' }
  | { kind: 'interrupt' }
  | { kind: 'pre-compact' }
  | { kind: 'post-compact' }
  | { kind: 'summary-update'; summary: string | null }
  | { kind: 'last-user-message'; message: string };

export interface IAgentProvider {
  readonly id: string;
  readonly displayName: string;
  readonly panelType: TPanelType;

  matchesProcess(commandName: string, args?: string[]): boolean;
  isValidSessionId(id: unknown): id is string;

  detectActiveSession(panePid: number, childPids?: number[], options?: IAgentSessionDetectionOptions): Promise<ISessionInfo>;
  isAgentRunning(panePid: number, childPids?: number[]): Promise<boolean>;
  watchSessions(
    panePid: number,
    onChange: (info: ISessionInfo) => void,
    options?: IAgentSessionWatchOptions,
  ): ISessionWatcher;

  buildResumeCommand(sessionId: string, options: IAgentResumeCommandOptions): Promise<string>;
  buildLaunchCommand(options: IAgentLaunchCommandOptions): Promise<string>;

  readSessionId(tab: ITab): string | null;
  writeSessionId(tab: ITab, sessionId: string | null | undefined): void;
  readJsonlPath(tab: ITab): string | null;
  writeJsonlPath(tab: ITab, jsonlPath: string | null | undefined): void;
  readSummary(tab: ITab): string | null;
  writeSummary(tab: ITab, summary: string | null | undefined): void;

  parsePaneTitle(paneTitle: string | null): string | null;
  sessionIdFromJsonlPath(jsonlPath: string | null | undefined): string | null;
  readRuntimeSnapshot(jsonlPath: string, options?: { force?: boolean }): Promise<IAgentRuntimeSnapshot>;
  readSessionHistoryStats(jsonlPath: string): Promise<IAgentSessionHistoryStats>;
  preflight(): Promise<IAgentPreflight>;
  writeWorkspacePrompt?(ws: IWorkspace): Promise<void>;

}
