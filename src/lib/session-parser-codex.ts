import fs from 'fs/promises';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { createLogger } from '@/lib/logger';
import { summarizeCodexExecInput } from '@/lib/codex-exec-summary';
import { uploadPathToImageUrl } from '@/lib/uploads-store';
import type {
  IIncrementalResult,
  IChunkReadResult,
  IParseResult,
  IPatchApplyFile,
  ITimelineApprovalRequest,
  ITimelineAssistantMessage,
  ITimelineAskUserQuestion,
  ITimelineContextCompacted,
  ITimelineEntry,
  ITimelineErrorNotice,
  ITimelineExecCommandStream,
  ITimelineInterrupt,
  ITimelineMcpToolCall,
  ITimelinePatchApply,
  ITimelinePlan,
  ITimelineReasoningSummary,
  ITimelineSessionExit,
  ITimelineTaskProgress,
  ITimelineToolCall,
  ITimelineToolResult,
  ITimelineTurnEnd,
  ITimelineUserMessage,
  ITimelineWebSearch,
  TApprovalKind,
  TErrorSeverity,
  TToolStatus,
} from '@/types/timeline';

const log = createLogger('codex-parser');
const WARN_DEDUP = new Set<string>();

const CHUNK_SIZE = 256_000; // 256KB
const STDOUT_BUFFER_LIMIT = 1_048_576;
const SUMMARY_PREVIEW_LIMIT = 100;
const TRUNCATED_SUFFIX_TEMPLATE = (total: number) => `\n[... truncated, total ${total} bytes]`;

const warnOnce = (key: string, payload: Record<string, unknown>, message: string) => {
  if (WARN_DEDUP.has(key)) return;
  WARN_DEDUP.add(key);
  log.warn(payload, message);
};

const RolloutItemSchema = z.object({
  timestamp: z.string().optional(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

type TRolloutItem = z.infer<typeof RolloutItemSchema>;

const tsToMillis = (raw: string | undefined): number => {
  if (!raw) return Date.now();
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : Date.now();
};

const tryParseJson = (raw: string): unknown | undefined => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const safeString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const safeNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const oneLineSummary = (text: string, limit = SUMMARY_PREVIEW_LIMIT): string => {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= limit) return compact;
  return compact.slice(0, limit - 1) + '…';
};

interface IInFlightExec {
  kind: 'exec';
  callId: string;
  command: string;
  parsedCommand?: string;
  cwd?: string;
  stdoutBuffer: string;
  truncated: boolean;
  startedAt: number;
}

interface IInFlightWebSearch {
  kind: 'web-search';
  callId: string;
  query?: string;
  startedAt: number;
}

interface IInFlightMcp {
  kind: 'mcp';
  callId: string;
  server: string;
  tool: string;
  argumentsSummary?: string;
  startedAt: number;
}

interface IInFlightPatchApply {
  kind: 'patch';
  callId: string;
  files: IPatchApplyFile[];
  diff?: string;
  startedAt: number;
}

type TInFlightEntry = IInFlightExec | IInFlightWebSearch | IInFlightMcp | IInFlightPatchApply;

const isPatchApply = (name: string): boolean => name === 'apply_patch';

const summarizeFunctionCall = (name: string, args: unknown): string => {
  if (typeof args !== 'object' || args === null) return name;
  const obj = args as Record<string, unknown>;
  if (name === 'exec_command') {
    const cmd = safeString(obj.cmd ?? obj.command).split('\n')[0];
    return cmd ? `$ ${cmd}` : '$ ';
  }
  if (name === 'shell' || name === 'bash') {
    const cmd = safeString(obj.command ?? obj.cmd).split('\n')[0];
    return cmd ? `$ ${cmd}` : '$ ';
  }
  if (name === 'read' || name === 'read_file') {
    const fp = safeString(obj.path ?? obj.file_path);
    return fp ? `Read ${fp}` : 'Read';
  }
  if (name === 'list_files' || name === 'list') {
    const cmd = safeString(obj.cmd ?? obj.path);
    return cmd ? `List ${cmd}` : 'List';
  }
  if (name === 'search' || name === 'grep') {
    const pattern = safeString(obj.pattern ?? obj.query);
    return pattern ? `Search "${pattern}"` : 'Search';
  }
  if (name === 'write' || name === 'write_file') {
    const fp = safeString(obj.path ?? obj.file_path);
    return fp ? `Write ${fp}` : 'Write';
  }
  const firstKey = Object.keys(obj)[0];
  if (!firstKey) return name;
  const v = obj[firstKey];
  const preview = typeof v === 'string' ? v : JSON.stringify(v);
  return `${name} ${oneLineSummary(preview, 60)}`;
};

const summarizeFunctionOutput = (output: string): string => {
  if (!output) return '';
  const trimmed = output.trim();
  const lines = trimmed.split('\n');
  if (lines.length > 1) return `${lines.length} lines`;
  return oneLineSummary(trimmed);
};

interface IPatchSummary {
  files: IPatchApplyFile[];
  diff?: string;
}

const FILE_HEADER_RE = /^\*\*\*\s+(Add|Update|Delete)\s+File:\s+(.+?)\s*$/i;

const parseApplyPatchInput = (input: string): IPatchSummary => {
  if (!input) return { files: [] };
  const files: IPatchApplyFile[] = [];
  for (const line of input.split('\n')) {
    const match = line.match(FILE_HEADER_RE);
    if (!match) continue;
    const status = match[1].toLowerCase();
    files.push({ path: match[2], status });
  }
  return { files, diff: input };
};

const errorSeverityFromType = (type: string): TErrorSeverity | null => {
  switch (type) {
    case 'error':
    case 'Error':
      return 'error';
    case 'warning':
    case 'Warning':
      return 'warning';
    case 'stream_error':
    case 'StreamError':
      return 'stream-error';
    case 'guardian_warning':
    case 'GuardianWarning':
      return 'guardian-warning';
    default:
      return null;
  }
};

const approvalKindFromType = (type: string): TApprovalKind | null => {
  switch (type) {
    case 'exec_approval_request':
    case 'ExecApprovalRequest':
      return 'exec';
    case 'apply_patch_approval_request':
    case 'ApplyPatchApprovalRequest':
      return 'apply-patch';
    case 'request_permissions':
    case 'RequestPermissions':
      return 'permissions';
    default:
      return null;
  }
};

const taskStatusFromValue = (value: unknown): 'pending' | 'in_progress' | 'completed' | 'blocked' => {
  if (value === 'in_progress' || value === 'completed' || value === 'blocked') return value;
  return 'pending';
};

interface ICodexParseState {
  inFlight: Map<string, TInFlightEntry>;
  staleWarnings: Set<string>;
  suppressedCallIds: Set<string>;
}

const createState = (): ICodexParseState => ({
  inFlight: new Map(),
  staleWarnings: new Set(),
  suppressedCallIds: new Set(),
});

const SUPPRESSED_FUNCTION_NAMES = new Set(['exec_command', 'shell', 'bash', 'write_stdin']);

const setInFlight = (state: ICodexParseState, callId: string, entry: TInFlightEntry) => {
  const existing = state.inFlight.get(callId);
  if (existing) {
    warnOnce(
      `callid-reuse-${callId}`,
      { callId, prevKind: existing.kind, nextKind: entry.kind },
      'in-flight call_id reused — overwriting prior entry',
    );
  }
  state.inFlight.set(callId, entry);
};

const buildExecEntry = (
  inFlight: IInFlightExec,
  endTimestamp: number,
  exitCode: number | undefined,
  durationMs: number | undefined,
  stderr: string | undefined,
  status: TToolStatus,
): ITimelineExecCommandStream => ({
  id: nanoid(),
  type: 'exec-command-stream',
  timestamp: endTimestamp,
  callId: inFlight.callId,
  command: inFlight.command,
  parsedCommand: inFlight.parsedCommand,
  cwd: inFlight.cwd,
  stdout: inFlight.stdoutBuffer,
  stderr: stderr && stderr.length > 0 ? stderr : undefined,
  exitCode,
  durationMs,
  truncated: inFlight.truncated,
  status,
});

const collectInFlightStdout = (entry: IInFlightExec, chunk: string) => {
  if (entry.truncated) return;
  if (entry.stdoutBuffer.length + chunk.length <= STDOUT_BUFFER_LIMIT) {
    entry.stdoutBuffer += chunk;
    return;
  }
  const remaining = STDOUT_BUFFER_LIMIT - entry.stdoutBuffer.length;
  if (remaining > 0) entry.stdoutBuffer += chunk.slice(0, remaining);
  entry.truncated = true;
  entry.stdoutBuffer += TRUNCATED_SUFFIX_TEMPLATE(entry.stdoutBuffer.length + chunk.length);
};

const flushStaleInFlight = (state: ICodexParseState, timestamp: number, entries: ITimelineEntry[]) => {
  if (state.inFlight.size === 0) return;
  for (const inflight of state.inFlight.values()) {
    if (state.staleWarnings.has(inflight.callId)) continue;
    state.staleWarnings.add(inflight.callId);
    entries.push({
      id: nanoid(),
      type: 'error-notice',
      timestamp,
      severity: 'warning',
      message: `In-flight ${inflight.kind} call ${inflight.callId} ended without completion`,
    } satisfies ITimelineErrorNotice);
    if (inflight.kind === 'exec') {
      entries.push(buildExecEntry(inflight, timestamp, undefined, undefined, undefined, 'error'));
    } else if (inflight.kind === 'web-search') {
      entries.push({
        id: nanoid(),
        type: 'web-search',
        timestamp,
        callId: inflight.callId,
        query: inflight.query,
        status: 'error',
      } satisfies ITimelineWebSearch);
    } else if (inflight.kind === 'mcp') {
      entries.push({
        id: nanoid(),
        type: 'mcp-tool-call',
        timestamp,
        callId: inflight.callId,
        server: inflight.server,
        tool: inflight.tool,
        argumentsSummary: inflight.argumentsSummary,
        status: 'error',
      } satisfies ITimelineMcpToolCall);
    } else if (inflight.kind === 'patch') {
      entries.push({
        id: nanoid(),
        type: 'patch-apply',
        timestamp,
        callId: inflight.callId,
        files: inflight.files,
        diff: inflight.diff,
        success: false,
        status: 'error',
      } satisfies ITimelinePatchApply);
    }
  }
  state.inFlight.clear();
};

const processResponseItem = (
  payload: Record<string, unknown>,
  timestamp: number,
  state: ICodexParseState,
): ITimelineEntry[] => {
  const type = safeString(payload.type);
  switch (type) {
    case 'message':
      return [];
    case 'reasoning': {
      const summaryRaw = Array.isArray(payload.summary) ? payload.summary : [];
      const summary: string[] = [];
      for (const item of summaryRaw) {
        if (typeof item === 'string') {
          if (item.trim()) summary.push(item);
          continue;
        }
        if (typeof item === 'object' && item !== null) {
          const obj = item as Record<string, unknown>;
          const text = safeString(obj.text);
          if (text.trim()) summary.push(text);
        }
      }
      const hasEncryptedContent =
        typeof payload.encrypted_content === 'string' && payload.encrypted_content.length > 0;
      if (summary.length === 0 && !hasEncryptedContent) return [];
      const entry: ITimelineReasoningSummary = {
        id: nanoid(),
        type: 'reasoning-summary',
        timestamp,
        summary,
        hasEncryptedContent,
      };
      return [entry];
    }
    case 'function_call': {
      const callId = safeString(payload.call_id);
      const name = safeString(payload.name);
      if (!callId || !name) return [];
      if (SUPPRESSED_FUNCTION_NAMES.has(name)) {
        state.suppressedCallIds.add(callId);
        return [];
      }
      const argsRaw = payload.arguments;
      const args = typeof argsRaw === 'string' ? tryParseJson(argsRaw) ?? argsRaw : argsRaw;
      const summary = summarizeFunctionCall(name, args);
      const entry: ITimelineToolCall = {
        id: nanoid(),
        type: 'tool-call',
        timestamp,
        toolUseId: callId,
        toolName: name,
        summary,
        status: 'pending',
      };
      return [entry];
    }
    case 'function_call_output': {
      const callId = safeString(payload.call_id);
      if (!callId) return [];
      if (state.suppressedCallIds.has(callId)) {
        state.suppressedCallIds.delete(callId);
        return [];
      }
      const output = safeString(payload.output);
      const entry: ITimelineToolResult = {
        id: nanoid(),
        type: 'tool-result',
        timestamp,
        toolUseId: callId,
        isError: false,
        summary: summarizeFunctionOutput(output),
      };
      return [entry];
    }
    case 'custom_tool_call': {
      const callId = safeString(payload.call_id);
      const name = safeString(payload.name);
      if (!callId || !name) return [];
      if (isPatchApply(name)) {
        const input = safeString(payload.input);
        const { files, diff } = parseApplyPatchInput(input);
        const status = safeString(payload.status);
        const finalStatus: TToolStatus =
          status === 'completed' ? 'success' : status === 'failed' ? 'error' : 'pending';
        state.suppressedCallIds.add(callId);
        const entry: ITimelinePatchApply = {
          id: nanoid(),
          type: 'patch-apply',
          timestamp,
          callId,
          files,
          diff,
          success: finalStatus === 'success',
          status: finalStatus,
        };
        return [entry];
      }
      const execSummary = name === 'exec' && typeof payload.input === 'string'
        ? summarizeCodexExecInput(payload.input)
        : null;
      const summary = execSummary?.summary ?? summarizeFunctionCall(name, payload.input);
      const entry: ITimelineToolCall = {
        id: nanoid(),
        type: 'tool-call',
        timestamp,
        toolUseId: callId,
        toolName: execSummary?.toolName ?? name,
        summary,
        status: safeString(payload.status) === 'completed' ? 'success' : 'pending',
      };
      return [entry];
    }
    case 'custom_tool_call_output': {
      const callId = safeString(payload.call_id);
      if (!callId) return [];
      if (state.suppressedCallIds.has(callId)) {
        state.suppressedCallIds.delete(callId);
        return [];
      }
      const output = safeString(payload.output);
      const entry: ITimelineToolResult = {
        id: nanoid(),
        type: 'tool-result',
        timestamp,
        toolUseId: callId,
        isError: false,
        summary: summarizeFunctionOutput(output),
      };
      return [entry];
    }
    case 'web_search_call': {
      const callId = safeString(payload.call_id) || nanoid();
      const status = safeString(payload.status);
      const entry: ITimelineWebSearch = {
        id: nanoid(),
        type: 'web-search',
        timestamp,
        callId,
        query: safeString(payload.query) || undefined,
        status: status === 'completed' ? 'success' : status === 'failed' ? 'error' : 'pending',
      };
      state.inFlight.delete(callId);
      return [entry];
    }
    default:
      return [];
  }
};

const processEventMsg = (
  payload: Record<string, unknown>,
  timestamp: number,
  state: ICodexParseState,
): ITimelineEntry[] => {
  const type = safeString(payload.type);

  const severity = errorSeverityFromType(type);
  if (severity) {
    const entry: ITimelineErrorNotice = {
      id: nanoid(),
      type: 'error-notice',
      timestamp,
      severity,
      message: safeString(payload.message) || `${type}`,
      retryStatus: typeof payload.retry_status === 'string' ? payload.retry_status : undefined,
      errorCode: typeof payload.codex_error_info === 'string' ? payload.codex_error_info : undefined,
    };
    return [entry];
  }

  const approvalKind = approvalKindFromType(type);
  if (approvalKind) {
    const callId = safeString(payload.call_id) || nanoid();
    const patchesRaw = Array.isArray(payload.patches) ? payload.patches : null;
    const permissionsRaw = Array.isArray(payload.permissions) ? payload.permissions : null;
    const entry: ITimelineApprovalRequest = {
      id: nanoid(),
      type: 'approval-request',
      timestamp,
      approvalKind,
      callId,
      command: typeof payload.command === 'string' ? payload.command : undefined,
      cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
      patches: patchesRaw
        ? patchesRaw
            .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
            .map((p) => ({ path: safeString(p.path), status: typeof p.status === 'string' ? p.status : undefined }))
        : undefined,
      permissions: permissionsRaw
        ? permissionsRaw.filter((p): p is string => typeof p === 'string')
        : undefined,
      status: 'pending',
    };
    return [entry];
  }

  switch (type) {
    case 'user_message': {
      const text = safeString(payload.message);
      if (!text) return [];
      const imagesRaw = Array.isArray(payload.images) ? payload.images : [];
      const localImagesRaw = Array.isArray(payload.local_images) ? payload.local_images : [];
      const images = imagesRaw.filter((s): s is string => typeof s === 'string');
      const localImages = localImagesRaw
        .filter((s): s is string => typeof s === 'string')
        .map((s) => uploadPathToImageUrl(s))
        .filter((s): s is string => !!s);
      const allImages = [...images, ...localImages];
      const entry: ITimelineUserMessage = {
        id: nanoid(),
        type: 'user-message',
        timestamp,
        text,
        ...(allImages.length > 0 ? { images: allImages } : {}),
      };
      return [entry];
    }
    case 'agent_message': {
      const message = safeString(payload.message);
      if (!message) return [];
      const entry: ITimelineAssistantMessage = {
        id: nanoid(),
        type: 'assistant-message',
        timestamp,
        markdown: message,
      };
      return [entry];
    }
    case 'task_complete':
    case 'TurnComplete': {
      const turn: ITimelineTurnEnd = {
        id: nanoid(),
        type: 'turn-end',
        timestamp,
      };
      return [turn];
    }
    case 'turn_aborted':
    case 'TurnAborted': {
      const entry: ITimelineInterrupt = {
        id: nanoid(),
        type: 'interrupt',
        timestamp,
      };
      return [entry];
    }
    case 'shutdown_complete':
    case 'ShutdownComplete': {
      const entry: ITimelineSessionExit = {
        id: nanoid(),
        type: 'session-exit',
        timestamp,
      };
      return [entry];
    }
    case 'plan_update':
    case 'PlanUpdate': {
      const planRaw = Array.isArray(payload.plan) ? payload.plan : [];
      const entries: ITimelineEntry[] = [];
      for (const item of planRaw) {
        if (typeof item !== 'object' || item === null) continue;
        const obj = item as Record<string, unknown>;
        const taskId = safeString(obj.task_id ?? obj.id);
        const status = taskStatusFromValue(obj.status);
        const subject = safeString(obj.subject ?? obj.title ?? obj.description);
        if (!taskId && !subject) continue;
        entries.push({
          id: nanoid(),
          type: 'task-progress',
          timestamp,
          action: 'update',
          taskId: taskId || subject,
          subject,
          description: typeof obj.description === 'string' ? obj.description : undefined,
          status,
        } satisfies ITimelineTaskProgress);
      }
      return entries;
    }
    case 'entered_review_mode':
    case 'EnteredReviewMode': {
      const description = safeString(payload.description);
      const entry: ITimelinePlan = {
        id: nanoid(),
        type: 'plan',
        timestamp,
        toolUseId: '',
        markdown: description || 'Entered review mode',
        status: 'pending',
      };
      return [entry];
    }
    case 'exited_review_mode':
    case 'ExitedReviewMode': {
      const outcome = safeString(payload.outcome);
      const status: TToolStatus = outcome === 'approved' ? 'success' : outcome === 'rejected' ? 'error' : 'pending';
      const entry: ITimelinePlan = {
        id: nanoid(),
        type: 'plan',
        timestamp,
        toolUseId: '',
        markdown: outcome ? `Review ${outcome}` : 'Exited review mode',
        status,
      };
      return [entry];
    }
    case 'request_user_input':
    case 'RequestUserInput': {
      const question = safeString(payload.question);
      if (!question) return [];
      const entry: ITimelineAskUserQuestion = {
        id: nanoid(),
        type: 'ask-user-question',
        timestamp,
        toolUseId: safeString(payload.call_id) || nanoid(),
        questions: [{ question, header: '', options: [], multiSelect: false }],
        status: 'pending',
      };
      return [entry];
    }
    case 'context_compacted':
    case 'ContextCompacted': {
      const entry: ITimelineContextCompacted = {
        id: nanoid(),
        type: 'context-compacted',
        timestamp,
        beforeTokens: safeNumber(payload.before_tokens),
        afterTokens: safeNumber(payload.after_tokens),
      };
      return [entry];
    }
    case 'exec_command_begin':
    case 'ExecCommandBegin': {
      const callId = safeString(payload.call_id);
      if (!callId) return [];
      const command = safeString(payload.command) || (Array.isArray(payload.command) ? (payload.command as string[]).join(' ') : '');
      const inflight: IInFlightExec = {
        kind: 'exec',
        callId,
        command,
        cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
        stdoutBuffer: '',
        truncated: false,
        startedAt: timestamp,
      };
      setInFlight(state, callId, inflight);
      return [];
    }
    case 'exec_command_delta':
    case 'ExecCommandDelta': {
      const callId = safeString(payload.call_id);
      const chunk = safeString(payload.chunk ?? payload.data);
      if (!callId || !chunk) return [];
      const existing = state.inFlight.get(callId);
      if (!existing || existing.kind !== 'exec') {
        warnOnce(`exec-delta-orphan-${callId}`, { callId }, 'exec_command_delta without begin');
        return [];
      }
      collectInFlightStdout(existing, chunk);
      return [];
    }
    case 'exec_command_end':
    case 'ExecCommandEnd': {
      const callId = safeString(payload.call_id);
      if (!callId) return [];
      const exitCode = safeNumber(payload.exit_code);
      const status: TToolStatus = exitCode === 0 ? 'success' : 'error';
      const stderr = typeof payload.stderr === 'string' ? payload.stderr : undefined;
      const durationMs = parseDurationMs(payload.duration);
      const existing = state.inFlight.get(callId);
      if (existing && existing.kind === 'exec') {
        const aggregated = typeof payload.aggregated_output === 'string' ? payload.aggregated_output : '';
        if (existing.stdoutBuffer.length === 0 && aggregated) {
          collectInFlightStdout(existing, aggregated);
        } else if (typeof payload.stdout === 'string' && payload.stdout && existing.stdoutBuffer.length === 0) {
          collectInFlightStdout(existing, payload.stdout);
        }
        const entry = buildExecEntry(existing, timestamp, exitCode, durationMs, stderr, status);
        state.inFlight.delete(callId);
        return [entry];
      }
      const command = readCommand(payload);
      const aggregated = typeof payload.aggregated_output === 'string' ? payload.aggregated_output : safeString(payload.stdout);
      const inflight: IInFlightExec = {
        kind: 'exec',
        callId,
        command,
        parsedCommand: readParsedCommand(payload),
        cwd: typeof payload.cwd === 'string' ? payload.cwd : undefined,
        stdoutBuffer: '',
        truncated: false,
        startedAt: timestamp,
      };
      if (aggregated) collectInFlightStdout(inflight, aggregated);
      return [buildExecEntry(inflight, timestamp, exitCode, durationMs, stderr, status)];
    }
    case 'web_search_begin':
    case 'WebSearchBegin': {
      const callId = safeString(payload.call_id);
      if (!callId) return [];
      setInFlight(state, callId, {
        kind: 'web-search',
        callId,
        query: safeString(payload.query) || undefined,
        startedAt: timestamp,
      });
      return [];
    }
    case 'web_search_end':
    case 'WebSearchEnd': {
      const callId = safeString(payload.call_id);
      if (!callId) return [];
      const existing = state.inFlight.get(callId);
      const query = existing?.kind === 'web-search' ? existing.query : safeString(payload.query) || undefined;
      const resultsRaw = Array.isArray(payload.results) ? payload.results : [];
      const resultsSummary =
        resultsRaw.length > 0 ? `${resultsRaw.length} results` : safeString(payload.summary) || undefined;
      state.inFlight.delete(callId);
      const entry: ITimelineWebSearch = {
        id: nanoid(),
        type: 'web-search',
        timestamp,
        callId,
        query,
        resultsSummary,
        resultCount: resultsRaw.length || undefined,
        status: 'success',
      };
      return [entry];
    }
    case 'mcp_tool_call_begin':
    case 'McpToolCallBegin': {
      const callId = safeString(payload.call_id);
      if (!callId) return [];
      setInFlight(state, callId, {
        kind: 'mcp',
        callId,
        server: safeString(payload.server),
        tool: safeString(payload.tool),
        argumentsSummary: oneLineSummary(JSON.stringify(payload.arguments ?? {}), 80),
        startedAt: timestamp,
      });
      return [];
    }
    case 'mcp_tool_call_end':
    case 'McpToolCallEnd': {
      const callId = safeString(payload.call_id);
      if (!callId) return [];
      const existing = state.inFlight.get(callId);
      const server = existing?.kind === 'mcp' ? existing.server : safeString(payload.server);
      const tool = existing?.kind === 'mcp' ? existing.tool : safeString(payload.tool);
      const argsSummary = existing?.kind === 'mcp' ? existing.argumentsSummary : undefined;
      state.inFlight.delete(callId);
      const resultText = JSON.stringify(payload.result ?? '');
      const entry: ITimelineMcpToolCall = {
        id: nanoid(),
        type: 'mcp-tool-call',
        timestamp,
        callId,
        server,
        tool,
        argumentsSummary: argsSummary,
        resultSummary: oneLineSummary(resultText, 120),
        status: 'success',
      };
      return [entry];
    }
    case 'patch_apply_begin':
    case 'PatchApplyBegin': {
      const callId = safeString(payload.call_id);
      if (!callId) return [];
      setInFlight(state, callId, {
        kind: 'patch',
        callId,
        files: [],
        startedAt: timestamp,
      });
      return [];
    }
    case 'patch_apply_updated':
    case 'PatchApplyUpdated': {
      const callId = safeString(payload.call_id);
      if (!callId) return [];
      const existing = state.inFlight.get(callId);
      if (!existing || existing.kind !== 'patch') return [];
      const filePath = safeString(payload.path);
      if (filePath) {
        existing.files.push({ path: filePath, status: typeof payload.status === 'string' ? payload.status : undefined });
      }
      return [];
    }
    case 'patch_apply_end':
    case 'PatchApplyEnd': {
      const callId = safeString(payload.call_id);
      if (!callId) return [];
      const existing = state.inFlight.get(callId);
      const success = payload.success !== false;
      const files = existing?.kind === 'patch' ? existing.files : [];
      state.inFlight.delete(callId);
      const entry: ITimelinePatchApply = {
        id: nanoid(),
        type: 'patch-apply',
        timestamp,
        callId,
        files,
        success,
        status: success ? 'success' : 'error',
      };
      return [entry];
    }
    default:
      return [];
  }
};

const readCommand = (payload: Record<string, unknown>): string => {
  if (typeof payload.command === 'string') return payload.command;
  if (Array.isArray(payload.command)) {
    const arr = payload.command.filter((s): s is string => typeof s === 'string');
    if (arr.length >= 3 && (arr[0] === '/bin/zsh' || arr[0] === '/bin/bash') && arr[1] === '-lc') {
      return arr.slice(2).join(' ');
    }
    return arr.join(' ');
  }
  return '';
};

const readParsedCommand = (payload: Record<string, unknown>): string | undefined => {
  const arr = Array.isArray(payload.parsed_cmd) ? payload.parsed_cmd : null;
  if (!arr || arr.length === 0) return undefined;
  const first = arr[0];
  if (typeof first !== 'object' || first === null) return undefined;
  const obj = first as Record<string, unknown>;
  return typeof obj.cmd === 'string' ? obj.cmd : undefined;
};

const parseDurationMs = (raw: unknown): number | undefined => {
  if (typeof raw === 'number') return raw;
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const secs = safeNumber(obj.secs) ?? 0;
    const nanos = safeNumber(obj.nanos) ?? 0;
    return secs * 1000 + nanos / 1_000_000;
  }
  return undefined;
};

const processItem = (
  item: TRolloutItem,
  state: ICodexParseState,
): ITimelineEntry[] => {
  const timestamp = tsToMillis(item.timestamp);
  const payload = (item.payload ?? {}) as Record<string, unknown>;
  switch (item.type) {
    case 'session_meta':
    case 'turn_context':
      return [];
    case 'response_item':
      return processResponseItem(payload, timestamp, state);
    case 'event_msg':
      return processEventMsg(payload, timestamp, state);
    case 'compacted':
      return [];
    default:
      return [];
  }
};

const mergeToolResults = (entries: ITimelineEntry[]): ITimelineEntry[] => {
  const callMap = new Map<string, ITimelineToolCall>();
  for (const entry of entries) {
    if (entry.type === 'tool-call') {
      callMap.set(entry.toolUseId, entry);
      continue;
    }
    if (entry.type === 'tool-result') {
      const call = callMap.get(entry.toolUseId);
      if (call) {
        call.status = entry.isError ? 'error' : 'success';
        if (entry.summary && !entry.isError) {
          const linesMatch = entry.summary.match(/^(\d+) lines$/);
          if (linesMatch && (call.toolName === 'exec_command' || call.toolName === 'shell' || call.toolName === 'bash')) {
            call.summary = `${call.summary} → ${linesMatch[1]} lines`;
          }
        }
      }
    }
  }
  return entries;
};

const parseLines = (
  lines: string[],
  state: ICodexParseState,
  lineOffsets?: number[],
): { entries: ITimelineEntry[]; entryLineOffsets: number[]; summary?: string; errorCount: number } => {
  const entries: ITimelineEntry[] = [];
  const entryLineOffsets: number[] = [];
  let summary: string | undefined;
  let errorCount = 0;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx];
    if (!rawLine.trim()) continue;
    const parsed = tryParseJson(rawLine);
    if (parsed === undefined) {
      errorCount++;
      warnOnce('codex-parse-error', { preview: rawLine.slice(0, 100) }, 'codex parse line failed');
      continue;
    }
    const validated = RolloutItemSchema.safeParse(parsed);
    if (!validated.success) {
      errorCount++;
      continue;
    }
    const item = validated.data;
    if (!summary && item.type === 'event_msg') {
      const payload = (item.payload ?? {}) as Record<string, unknown>;
      if (safeString(payload.type) === 'user_message') {
        const msg = safeString(payload.message);
        if (msg) summary = oneLineSummary(msg);
      }
    }
    const produced = processItem(item, state);
    if (produced.length > 0) {
      entries.push(...produced);
      entryLineOffsets.push(...produced.map(() => lineOffsets?.[lineIdx] ?? 0));
    }
  }

  return { entries: mergeToolResults(entries), entryLineOffsets, summary, errorCount };
};

const readChunk = async (
  filePath: string, from: number, to: number,
): Promise<{ content: string; validFrom: number }> => {
  const readSize = to - from;
  if (readSize <= 0) return { content: '', validFrom: from };
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(readSize);
    await handle.read(buffer, 0, readSize, from);
    const raw = buffer.toString('utf-8');
    if (from === 0) return { content: raw, validFrom: 0 };
    const firstNewline = raw.indexOf('\n');
    if (firstNewline < 0) return { content: '', validFrom: to };
    const validFrom = from + Buffer.byteLength(raw.slice(0, firstNewline + 1), 'utf-8');
    return { content: raw.slice(firstNewline + 1), validFrom };
  } finally {
    await handle.close();
  }
};

const readExactChunk = async (
  filePath: string, from: number, to: number,
): Promise<{ content: string; validFrom: number }> => {
  const readSize = to - from;
  if (readSize <= 0) return { content: '', validFrom: from };
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(readSize);
    await handle.read(buffer, 0, readSize, from);
    return { content: buffer.toString('utf-8'), validFrom: from };
  } finally {
    await handle.close();
  }
};

const splitLinesWithOffsets = (content: string, startOffset: number): { lines: string[]; lineOffsets: number[] } => {
  const lines = content.split('\n');
  const lineOffsets: number[] = [];
  let offset = startOffset;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += Buffer.byteLength(line, 'utf-8') + 1;
  }
  return { lines, lineOffsets };
};

const parseContentWithOffsets = (
  content: string,
  startOffset: number,
  state: ICodexParseState,
): IParseResult => {
  const { lines, lineOffsets } = splitLinesWithOffsets(content, startOffset);
  const { entries, entryLineOffsets, summary, errorCount } = parseLines(lines, state, lineOffsets);
  return {
    entries,
    entryLineOffsets,
    lastOffset: startOffset + Buffer.byteLength(content, 'utf-8'),
    totalLines: lines.filter((line) => line.trim()).length,
    errorCount,
    summary,
  };
};

const emptyChunk = (): IChunkReadResult => ({
  entries: [], startByteOffset: 0, fileSize: 0, hasMore: false, errorCount: 0,
});

const sliceChunkResult = (
  result: IParseResult,
  fileSize: number,
  fallbackStartByteOffset: number,
  maxEntries: number,
): IChunkReadResult => {
  const sliced = result.entries.length > maxEntries;
  const sliceStart = sliced ? result.entries.length - maxEntries : 0;
  const entries = sliced ? result.entries.slice(-maxEntries) : result.entries;
  const startByteOffset = sliced
    ? result.entryLineOffsets[sliceStart] ?? fallbackStartByteOffset
    : fallbackStartByteOffset;
  return {
    entries,
    startByteOffset,
    fileSize,
    hasMore: startByteOffset > 0,
    errorCount: result.errorCount,
    summary: result.summary,
  };
};

const readCodexRange = async (
  filePath: string,
  fromByte: number,
  toByte: number,
  displayFromByte = fromByte,
): Promise<IChunkReadResult> => {
  const empty = emptyChunk();
  try {
    const stat = await fs.stat(filePath);
    const fileSize = stat.size;
    const from = Math.max(0, Math.min(fromByte, fileSize));
    const to = Math.max(from, Math.min(toByte, fileSize));
    if (to <= from) return { ...empty, fileSize };

    const { content, validFrom } = await readExactChunk(filePath, from, to);
    const state = createState();
    const result = parseContentWithOffsets(content, validFrom, state);
    const displayEntries = result.entries.filter((_, idx) => {
      const entryOffset = result.entryLineOffsets[idx] ?? validFrom;
      return entryOffset >= displayFromByte;
    });
    return {
      entries: displayEntries,
      startByteOffset: Math.max(validFrom, displayFromByte),
      fileSize,
      hasMore: Math.max(validFrom, displayFromByte) > 0,
      errorCount: result.errorCount,
      summary: result.summary,
    };
  } catch {
    return empty;
  }
};

export class CodexParser {
  private readonly jsonlPath: string;
  private lastOffset = 0;
  private pendingBuffer = '';
  private state: ICodexParseState;

  constructor(jsonlPath: string) {
    this.jsonlPath = jsonlPath;
    this.state = createState();
  }

  reset(): void {
    this.lastOffset = 0;
    this.pendingBuffer = '';
    this.state = createState();
  }

  dispose(): void {
    this.state.inFlight.clear();
    this.pendingBuffer = '';
  }

  async parseAll(): Promise<IParseResult> {
    this.lastOffset = 0;
    this.pendingBuffer = '';
    this.state = createState();
    let stat: { size: number };
    try {
      stat = await fs.stat(this.jsonlPath);
    } catch {
      return { entries: [], entryLineOffsets: [], lastOffset: 0, totalLines: 0, errorCount: 0 };
    }
    if (stat.size === 0) {
      return { entries: [], entryLineOffsets: [], lastOffset: 0, totalLines: 0, errorCount: 0 };
    }
    const content = await fs.readFile(this.jsonlPath, 'utf-8');
    const { entries, entryLineOffsets, summary, errorCount, totalLines } = parseContentWithOffsets(content, 0, this.state);
    this.lastOffset = Buffer.byteLength(content, 'utf-8');
    return {
      entries,
      entryLineOffsets,
      lastOffset: this.lastOffset,
      totalLines,
      errorCount,
      summary,
    };
  }

  async parseTail(maxEntries: number): Promise<IChunkReadResult> {
    const empty = emptyChunk();
    this.reset();
    try {
      const stat = await fs.stat(this.jsonlPath);
      const fileSize = stat.size;
      if (fileSize === 0) return empty;

      let chunkSize = CHUNK_SIZE;
      while (true) {
        const from = Math.max(0, fileSize - chunkSize);
        const { content, validFrom } = await readChunk(this.jsonlPath, from, fileSize);
        if (!content) {
          if (from === 0) return empty;
          chunkSize *= 2;
          continue;
        }

        this.state = createState();
        const result = parseContentWithOffsets(content, validFrom, this.state);
        if (result.entries.length >= maxEntries || from === 0) {
          this.lastOffset = fileSize;
          this.pendingBuffer = '';
          const fallbackStartByteOffset = from === 0 ? 0 : validFrom;
          return sliceChunkResult(result, fileSize, fallbackStartByteOffset, maxEntries);
        }
        if (from === 0) return empty;
        chunkSize *= 2;
      }
    } catch {
      return empty;
    }
  }

  async parseIncremental(): Promise<IIncrementalResult> {
    let handle;
    try {
      handle = await fs.open(this.jsonlPath, 'r');
    } catch {
      return { newEntries: [], newOffset: this.lastOffset, pendingBuffer: this.pendingBuffer };
    }

    try {
      const stat = await handle.stat();
      const size = stat.size;

      if (size < this.lastOffset) {
        await handle.close();
        this.reset();
        const all = await this.parseAll();
        return { newEntries: all.entries, newOffset: all.lastOffset, pendingBuffer: '' };
      }

      if (this.lastOffset >= size) {
        return { newEntries: [], newOffset: this.lastOffset, pendingBuffer: this.pendingBuffer };
      }

      const buffer = Buffer.alloc(size - this.lastOffset);
      await handle.read(buffer, 0, buffer.length, this.lastOffset);

      const rawContent = this.pendingBuffer + buffer.toString('utf-8');
      const endsWithNewline = rawContent.endsWith('\n');
      const segments = rawContent.split('\n');
      let newPending = '';
      if (!endsWithNewline) {
        const lastSegment = segments.pop() ?? '';
        if (lastSegment) {
          if (tryParseJson(lastSegment) !== undefined) {
            segments.push(lastSegment);
          } else {
            newPending = lastSegment;
          }
        }
      }
      const { entries } = parseLines(segments, this.state);
      this.lastOffset = size;
      this.pendingBuffer = newPending;
      return { newEntries: entries, newOffset: size, pendingBuffer: newPending };
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : err, path: this.jsonlPath }, 'codex incremental parse failed');
      return { newEntries: [], newOffset: this.lastOffset, pendingBuffer: this.pendingBuffer };
    } finally {
      try {
        await handle.close();
      } catch {
        /* already closed */
      }
    }
  }

  flushStale(timestamp: number = Date.now()): ITimelineEntry[] {
    const entries: ITimelineEntry[] = [];
    flushStaleInFlight(this.state, timestamp, entries);
    return entries;
  }

  get offset(): number {
    return this.lastOffset;
  }

  get path(): string {
    return this.jsonlPath;
  }
}

export const createCodexParser = (jsonlPath: string): CodexParser => new CodexParser(jsonlPath);

export const parseCodexContent = (content: string): ITimelineEntry[] => {
  const state = createState();
  return parseLines(content.split('\n'), state).entries;
};

export const readTailCodexEntries = async (
  filePath: string,
  maxEntries: number,
): Promise<IChunkReadResult> => {
  const parser = createCodexParser(filePath);
  return parser.parseTail(maxEntries);
};

export const readCodexEntriesBefore = async (
  filePath: string,
  beforeByte: number,
  maxEntries: number,
  untilByte?: number,
): Promise<IChunkReadResult> => {
  const empty = emptyChunk();
  try {
    if (beforeByte <= 0) return empty;
    const stat = await fs.stat(filePath);
    const fileSize = stat.size;
    const currentStart = Math.max(0, Math.min(beforeByte, fileSize));
    const rangeEnd = Math.max(currentStart, Math.min(untilByte ?? fileSize, fileSize));

    let chunkSize = CHUNK_SIZE;
    while (true) {
      const from = Math.max(0, currentStart - chunkSize);
      const { content, validFrom } = await readChunk(filePath, from, currentStart);
      if (content) {
        const state = createState();
        const result = parseContentWithOffsets(content, validFrom, state);
        if (result.entries.length >= maxEntries || from === 0) {
          const parseStartByteOffset = from === 0 ? 0 : validFrom;
          const previousPage = sliceChunkResult(
            result,
            fileSize,
            parseStartByteOffset,
            maxEntries,
          );
          return readCodexRange(filePath, parseStartByteOffset, rangeEnd, previousPage.startByteOffset);
        }
      }
      if (from === 0) {
        return readCodexRange(filePath, 0, rangeEnd);
      }
      chunkSize *= 2;
    }
  } catch {
    return empty;
  }
};
