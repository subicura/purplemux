import type { TCliState, TToolName, IAskUserQuestionItem } from '@/types/timeline';
import type { TPanelType } from '@/types/terminal';
import type { ISessionHistoryEntry } from '@/types/session-history';
import type { IPermissionRequest } from '@/types/codex-permission';

export type TTerminalStatus = 'idle' | 'running' | 'server';

export type TEventName = 'session-start' | 'prompt-submit' | 'notification' | 'stop' | 'interrupt';

export interface ILastEvent {
  name: TEventName;
  at: number;
  seq: number;
}

export interface ICurrentAction {
  toolName: TToolName | null;
  summary: string;
}

export interface ITabStatusEntry {
  cliState: TCliState;
  workspaceId: string;
  tabName: string;
  currentProcess?: string;
  paneTitle?: string;
  tmuxSession: string;
  panelType?: TPanelType;
  terminalStatus?: TTerminalStatus;
  listeningPorts?: number[];
  agentProviderId?: string;
  agentSessionId?: string | null;
  agentSummary?: string | null;
  lastUserMessage?: string | null;
  lastAssistantMessage?: string | null;
  currentAction?: ICurrentAction | null;
  readyForReviewAt?: number | null;
  busySince?: number | null;
  dismissedAt?: number | null;
  compactingSince?: number | null;
  permissionRequest?: IPermissionRequest | null;
  pendingQuestions?: IAskUserQuestionItem[] | null;
  processRetries?: number;
  jsonlPath?: string | null;
  lastEvent?: ILastEvent | null;
  eventSeq?: number;
  lastInterruptTs?: number;
  // Wall-clock timestamp of the most recent agent launch/resume signal
  // (auto-resume sendKeys, session-start hook, synthetic interrupt).
  // Drives the F1 grace window that suppresses spurious inactive transitions
  // during the agent's boot-up. Runtime only — not persisted to layout.
  lastResumeOrStartedAt?: number;
}

export type TTabDisplayStatus = 'busy' | 'ready-for-review' | 'needs-input' | 'idle' | 'unknown';

export type IClientTabStatusEntry = Omit<ITabStatusEntry, 'tmuxSession' | 'jsonlPath' | 'processRetries'>;

export interface IStatusSyncMessage {
  type: 'status:sync';
  tabs: Record<string, IClientTabStatusEntry>;
}

export interface IStatusUpdateMessage {
  type: 'status:update';
  tabId: string;
  cliState: TCliState | null;
  workspaceId: string;
  tabName: string;
  currentProcess?: string;
  paneTitle?: string;
  panelType?: TPanelType;
  terminalStatus?: TTerminalStatus;
  listeningPorts?: number[];
  agentProviderId?: string;
  agentSessionId?: string | null;
  agentSummary?: string | null;
  lastUserMessage?: string | null;
  lastAssistantMessage?: string | null;
  currentAction?: ICurrentAction | null;
  readyForReviewAt?: number | null;
  busySince?: number | null;
  dismissedAt?: number | null;
  compactingSince?: number | null;
  permissionRequest?: IPermissionRequest | null;
  pendingQuestions?: IAskUserQuestionItem[] | null;
  lastEvent?: ILastEvent | null;
  eventSeq?: number;
}

export interface IRateLimitWindow {
  used_percentage: number;
  resets_at: number;
}

export interface IRateLimitsData {
  ts: number;
  five_hour: IRateLimitWindow | null;
  seven_day: IRateLimitWindow | null;
}

export type TRateLimitsProvider = 'claude' | 'codex';

export interface IRateLimitsCache {
  ts: number;
  claude?: IRateLimitsData | null;
  codex?: IRateLimitsData | null;
}

export interface IRateLimitsUpdateMessage {
  type: 'rate-limits:update';
  data: IRateLimitsCache;
}

export interface ISessionHistorySyncMessage {
  type: 'session-history:sync';
  entries: ISessionHistoryEntry[];
}

export interface ISessionHistoryUpdateMessage {
  type: 'session-history:update';
  entry: ISessionHistoryEntry;
}

export interface IStatusHookEventMessage {
  type: 'status:hook-event';
  tabId: string;
  event: ILastEvent;
}

export type TStatusServerMessage = IStatusSyncMessage | IStatusUpdateMessage | IRateLimitsUpdateMessage | ISessionHistorySyncMessage | ISessionHistoryUpdateMessage | IStatusHookEventMessage;

export interface IStatusTabDismissedMessage {
  type: 'status:tab-dismissed';
  tabId: string;
}

export interface IStatusRequestSyncMessage {
  type: 'status:request-sync';
}

export interface IStatusAckNotificationMessage {
  type: 'status:ack-notification';
  tabId: string;
  seq: number;
}

export type TStatusClientMessage =
  | IStatusTabDismissedMessage
  | IStatusRequestSyncMessage
  | IStatusAckNotificationMessage;
