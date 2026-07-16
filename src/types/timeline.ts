export type TSessionDetectionStatus = 'unknown' | 'starting' | 'running' | 'not-running' | 'not-initialized' | 'not-installed';

export type TCliState = 'idle' | 'busy' | 'inactive' | 'ready-for-review' | 'needs-input' | 'cancelled' | 'unknown';

export type TTimelineConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface ISessionInfo {
  status: TSessionDetectionStatus;
  sessionId: string | null;
  jsonlPath: string | null;
  pid: number | null;
  startedAt: number | null;
  cwd: string | null;
}

export type TTaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked';

export interface ITaskItem {
  taskId: string;
  subject: string;
  description?: string;
  status: TTaskStatus;
}

export type TTimelineEntryType =
  | 'user-message'
  | 'assistant-message'
  | 'thinking'
  | 'tool-call'
  | 'tool-result'
  | 'agent-group'
  | 'task-notification'
  | 'task-progress'
  | 'plan'
  | 'ask-user-question'
  | 'interrupt'
  | 'session-exit'
  | 'turn-end'
  | 'reasoning-summary'
  | 'error-notice'
  | 'approval-request'
  | 'exec-command-stream'
  | 'web-search'
  | 'mcp-tool-call'
  | 'patch-apply'
  | 'context-compacted';

export interface ITimelineUserMessage {
  id: string;
  type: 'user-message';
  timestamp: number;
  text: string;
  images?: string[];
  pending?: boolean;
  attachmentPlaceholder?: boolean;
  fadingOut?: boolean;
}

export interface ITimelineAssistantMessage {
  id: string;
  type: 'assistant-message';
  timestamp: number;
  markdown: string;
  stopReason?: string | null;
  model?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation?: {
      ephemeral_5m_input_tokens?: number;
      ephemeral_1h_input_tokens?: number;
    };
    speed?: 'fast' | string;
    server_tool_use?: {
      web_search_requests?: number;
    };
  };
}

export interface ITimelineThinking {
  id: string;
  type: 'thinking';
  timestamp: number;
  thinking: string;
}

export type TToolName = 'Read' | 'Edit' | 'Write' | 'Bash' | 'Grep' | 'Glob' | 'Agent' | string;

export type TToolStatus = 'pending' | 'success' | 'error';

export interface ITimelineDiff {
  filePath: string;
  oldString: string;
  newString: string;
}

export interface ITimelineToolCall {
  id: string;
  type: 'tool-call';
  timestamp: number;
  toolUseId: string;
  toolName: TToolName;
  summary: string;
  filePath?: string;
  diff?: ITimelineDiff;
  status: TToolStatus;
}

export interface ITimelineToolResult {
  id: string;
  type: 'tool-result';
  timestamp: number;
  toolUseId: string;
  isError: boolean;
  summary: string;
  answers?: Record<string, string>;
}

export interface ITimelineAgentGroup {
  id: string;
  type: 'agent-group';
  timestamp: number;
  agentType: string;
  description: string;
  entryCount: number;
  entries: ITimelineEntry[];
}

export interface ITimelineTaskNotification {
  id: string;
  type: 'task-notification';
  timestamp: number;
  taskId: string;
  status: 'completed' | 'failed' | string;
  summary: string;
  result?: string;
  usage?: {
    totalTokens?: number;
    toolUses?: number;
    durationMs?: number;
  };
}

export interface ITimelineTaskProgress {
  id: string;
  type: 'task-progress';
  timestamp: number;
  action: 'create' | 'update';
  taskId: string;
  toolUseId?: string;
  subject?: string;
  description?: string;
  status: TTaskStatus;
}

export interface IPlanAllowedPrompt {
  tool: string;
  prompt: string;
}

export interface ITimelinePlan {
  id: string;
  type: 'plan';
  timestamp: number;
  toolUseId: string;
  markdown: string;
  filePath?: string;
  allowedPrompts?: IPlanAllowedPrompt[];
  status: TToolStatus;
}

export interface IAskUserQuestionOption {
  label: string;
  description: string;
}

export interface IAskUserQuestionItem {
  question: string;
  header: string;
  options: IAskUserQuestionOption[];
  multiSelect: boolean;
  allowCustomAnswer?: boolean;
}

export interface ITimelineAskUserQuestion {
  id: string;
  type: 'ask-user-question';
  timestamp: number;
  toolUseId: string;
  questions: IAskUserQuestionItem[];
  status: TToolStatus;
  answer?: string;
  answers?: Record<string, string>;
}

export interface ITimelineInterrupt {
  id: string;
  type: 'interrupt';
  timestamp: number;
}

export interface ITimelineSessionExit {
  id: string;
  type: 'session-exit';
  timestamp: number;
}

export interface ITimelineTurnEnd {
  id: string;
  type: 'turn-end';
  timestamp: number;
}

export interface ITimelineReasoningSummary {
  id: string;
  type: 'reasoning-summary';
  timestamp: number;
  summary: string[];
  hasEncryptedContent: boolean;
}

export type TErrorSeverity = 'error' | 'warning' | 'stream-error' | 'guardian-warning';

export interface ITimelineErrorNotice {
  id: string;
  type: 'error-notice';
  timestamp: number;
  severity: TErrorSeverity;
  message: string;
  retryStatus?: string;
  errorCode?: string;
}

export type TApprovalKind = 'exec' | 'apply-patch' | 'permissions';

export interface ITimelineApprovalRequest {
  id: string;
  type: 'approval-request';
  timestamp: number;
  approvalKind: TApprovalKind;
  callId: string;
  command?: string;
  cwd?: string;
  patches?: Array<{ path: string; status?: string }>;
  permissions?: string[];
  status: TToolStatus;
}

export interface ITimelineExecCommandStream {
  id: string;
  type: 'exec-command-stream';
  timestamp: number;
  callId: string;
  command: string;
  parsedCommand?: string;
  cwd?: string;
  stdout: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  truncated?: boolean;
  status: TToolStatus;
}

export interface ITimelineWebSearch {
  id: string;
  type: 'web-search';
  timestamp: number;
  callId: string;
  query?: string;
  resultsSummary?: string;
  resultCount?: number;
  status: TToolStatus;
}

export interface ITimelineMcpToolCall {
  id: string;
  type: 'mcp-tool-call';
  timestamp: number;
  callId: string;
  server: string;
  tool: string;
  argumentsSummary?: string;
  resultSummary?: string;
  status: TToolStatus;
}

export interface IPatchApplyFile {
  path: string;
  status?: string;
}

export interface ITimelinePatchApply {
  id: string;
  type: 'patch-apply';
  timestamp: number;
  callId: string;
  files: IPatchApplyFile[];
  diff?: string;
  success?: boolean;
  status: TToolStatus;
}

export interface ITimelineContextCompacted {
  id: string;
  type: 'context-compacted';
  timestamp: number;
  beforeTokens?: number;
  afterTokens?: number;
}

export type ITimelineEntry =
  | ITimelineUserMessage
  | ITimelineAssistantMessage
  | ITimelineThinking
  | ITimelineToolCall
  | ITimelineToolResult
  | ITimelineAgentGroup
  | ITimelineTaskNotification
  | ITimelineTaskProgress
  | ITimelinePlan
  | ITimelineAskUserQuestion
  | ITimelineInterrupt
  | ITimelineSessionExit
  | ITimelineTurnEnd
  | ITimelineReasoningSummary
  | ITimelineErrorNotice
  | ITimelineApprovalRequest
  | ITimelineExecCommandStream
  | ITimelineWebSearch
  | ITimelineMcpToolCall
  | ITimelinePatchApply
  | ITimelineContextCompacted;

export interface IInitMeta {
  createdAt: string | null;
  updatedAt: string | null;
  lastTimestamp: number;
  fileSize: number;
  userCount: number;
  assistantCount: number;
  customTitle?: string;
}

export interface ISessionStats {
  sessionId: string;
  transcriptPath?: string;

  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  cost?: number | null;
  currentContextTokens?: number;
  contextWindowSize?: number;
  usedPercentage?: number | null;
  model?: string | null;
  exceeds200k?: boolean;
  receivedAt?: number;
}

export interface ITimelineInitMessage {
  type: 'timeline:init';
  entries: ITimelineEntry[];
  sessionId: string;
  totalEntries: number;
  startByteOffset: number;
  hasMore: boolean;
  jsonlPath?: string | null;
  summary?: string;
  meta?: IInitMeta;
  sessionStats?: ISessionStats | null;
  isClaudeStarting?: boolean;
}

export interface ITimelineStatsUpdateMessage {
  type: 'timeline:stats-update';
  sessionStats: ISessionStats;
}

export interface ITimelineAppendMessage {
  type: 'timeline:append';
  entries: ITimelineEntry[];
}

export interface ITimelineSessionChangedMessage {
  type: 'timeline:session-changed';
  newSessionId: string;
  reason: string;
}

export interface ITimelineErrorMessage {
  type: 'timeline:error';
  code: string;
  message: string;
}

export interface ITimelineResumeStartedMessage {
  type: 'timeline:resume-started';
  sessionId: string;
  jsonlPath: string | null;
}

export interface ITimelineResumeBlockedMessage {
  type: 'timeline:resume-blocked';
  reason: string;
  processName?: string;
}

export interface ITimelineResumeErrorMessage {
  type: 'timeline:resume-error';
  message: string;
}

export type TTimelineServerMessage =
  | ITimelineInitMessage
  | ITimelineAppendMessage
  | ITimelineSessionChangedMessage
  | ITimelineErrorMessage
  | ITimelineResumeStartedMessage
  | ITimelineResumeBlockedMessage
  | ITimelineResumeErrorMessage
  | ITimelineStatsUpdateMessage;

export interface ITimelineSubscribeMessage {
  type: 'timeline:subscribe';
  jsonlPath: string;
}

export interface ITimelineUnsubscribeMessage {
  type: 'timeline:unsubscribe';
}

export interface ITimelineResumeMessage {
  type: 'timeline:resume';
  sessionId: string;
  tmuxSession: string;
}

export type TTimelineClientMessage =
  | ITimelineSubscribeMessage
  | ITimelineUnsubscribeMessage
  | ITimelineResumeMessage;

export interface IChunkReadResult {
  entries: ITimelineEntry[];
  startByteOffset: number;
  fileSize: number;
  hasMore: boolean;
  errorCount: number;
  summary?: string;
  customTitle?: string;
}

export interface IParseResult {
  entries: ITimelineEntry[];
  entryLineOffsets: number[];
  lastOffset: number;
  totalLines: number;
  errorCount: number;
  summary?: string;
  customTitle?: string;
}

export interface IIncrementalResult {
  newEntries: ITimelineEntry[];
  newOffset: number;
  pendingBuffer: string;
}

export interface ISessionMeta {
  sessionId: string;
  startedAt: string;
  lastActivityAt: string;
  firstMessage: string;
  turnCount: number;
}
