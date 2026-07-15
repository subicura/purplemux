import { useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { useTranslations } from 'next-intl';
import { Terminal, RefreshCw, OctagonX, LogOut, ChevronsUp, MessageSquareMore } from 'lucide-react';
import { diffLines } from 'diff';
import Spinner from '@/components/ui/spinner';
import { useStickToBottom } from 'use-stick-to-bottom';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type {
  ITimelineEntry,
  ITimelineExecCommandStream,
  ITimelineMcpToolCall,
  ITimelinePatchApply,
  ITimelineToolCall,
  ITimelineToolResult,
  ITimelineWebSearch,
  ITaskItem,
  IInitMeta,
  ISessionStats,
  TCliState,
  TTimelineConnectionStatus,
} from '@/types/timeline';
import UserMessageItem from '@/components/features/timeline/user-message-item';
import AssistantMessageItem from '@/components/features/timeline/assistant-message-item';
import AgentGroupItem from '@/components/features/timeline/agent-group-item';
import TaskNotificationItem from '@/components/features/timeline/task-notification-item';
import ToolGroupItem from '@/components/features/timeline/tool-group-item';
import PlanItem from '@/components/features/timeline/plan-item';
import AskUserQuestionItem from '@/components/features/timeline/ask-user-question-item';
import TaskChecklist from '@/components/features/timeline/task-checklist';
import TaskProgressItem from '@/components/features/timeline/task-progress-item';
import ScrollToBottomButton from '@/components/features/timeline/scroll-to-bottom-button';
import PermissionPromptItem from '@/components/features/timeline/permission-prompt-item';
import ApprovalRequestItem from '@/components/features/timeline/approval-request-item';
import ExecCommandStreamItem from '@/components/features/timeline/exec-command-stream-item';
import WebSearchItem from '@/components/features/timeline/web-search-item';
import McpToolCallItem from '@/components/features/timeline/mcp-tool-call-item';
import PatchApplyItem from '@/components/features/timeline/patch-apply-item';
import ContextCompactedItem from '@/components/features/timeline/context-compacted-item';
import ErrorNoticeItem from '@/components/features/timeline/error-notice-item';
import TimelineSearchBar from '@/components/features/timeline/timeline-search-bar';
import { getEntryText } from '@/lib/timeline-entry-text';
import { firstMatchRange } from '@/lib/timeline-search-dom';
import { useTimelineSearchHighlight } from '@/hooks/use-timeline-search-highlight';
import { reloadForReconnectRecovery, shouldPromptMobileReloadRecovery } from '@/lib/ws-reload-recovery';

interface ITimelineViewProps {
  entries: ITimelineEntry[];
  tasks: ITaskItem[];
  sessionId: string | null;
  sessionName?: string;
  tabId?: string;
  initMeta?: IInitMeta;
  sessionStats?: ISessionStats | null;
  cliState: TCliState;
  compactingSince?: number | null;
  wsStatus: TTimelineConnectionStatus;
  isLoading: boolean;
  error: string | null;
  onRetry: () => void;
  onLoadMore: () => Promise<void>;
  hasMore: boolean;
  scrollToBottomRef?: React.MutableRefObject<(() => void) | undefined>;
  active?: boolean;
}

const RESUME_TOKEN_THRESHOLD = 100_000;
const RESUME_IDLE_MINUTES = 70;
const ANCHOR_OFFSET = 12;
const ANCHOR_SETTLE_DELAY_MS = 300;
const OVERFLOW_SENTINEL_ROOT_MARGIN = '0px 0px 4px 0px';

const getOffsetInScroller = (el: HTMLElement, scrollEl: HTMLElement): number => {
  const elRect = el.getBoundingClientRect();
  const scrollRect = scrollEl.getBoundingClientRect();
  return elRect.top - scrollRect.top + scrollEl.scrollTop;
};

const ElapsedTime = ({ since }: { since: number }) => {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const update = () => setElapsed(Math.max(0, Math.floor((Date.now() - since) / 1000)));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [since]);

  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');

  return <span className="tabular-nums">{mm}:{ss}</span>;
};

type TGroupedItem =
  | { type: 'entry'; id: string; entry: ITimelineEntry }
  | { type: 'tool-group'; id: string; toolCalls: ITimelineToolCall[]; toolResults: ITimelineToolResult[] };

type TAdaptedToolGroupEntry = {
  calls: ITimelineToolCall[];
  results: ITimelineToolResult[];
};

const summarizeToolOutput = (output: string): string => {
  const trimmed = output.trim();
  if (!trimmed) return '';
  const lines = trimmed.split('\n');
  return lines.length > 1 ? `${lines.length} lines` : trimmed.slice(0, 100);
};

const pluralize = (count: number, singular: string, plural: string): string =>
  `${count} ${count === 1 ? singular : plural}`;

const toAdaptedToolGroupEntry = (
  call: ITimelineToolCall,
  result?: ITimelineToolResult,
): TAdaptedToolGroupEntry => ({
  calls: [call],
  results: result ? [result] : [],
});

const adaptExecCommandToToolGroup = (
  entry: ITimelineExecCommandStream,
): TAdaptedToolGroupEntry => {
  const command = entry.parsedCommand ?? entry.command;
  const outputSummary = summarizeToolOutput(entry.status === 'error' ? entry.stderr || entry.stdout : entry.stdout);
  const lineCountMatch = outputSummary.match(/^(\d+) lines$/);
  const summary = entry.status === 'success' && lineCountMatch
    ? `$ ${command} → ${lineCountMatch[1]} lines`
    : `$ ${command}`;

  return toAdaptedToolGroupEntry(
    {
      id: entry.id,
      type: 'tool-call',
      timestamp: entry.timestamp,
      toolUseId: entry.callId,
      toolName: 'Bash',
      summary,
      status: entry.status,
    },
    outputSummary && !lineCountMatch
      ? {
          id: `${entry.id}:result`,
          type: 'tool-result',
          timestamp: entry.timestamp,
          toolUseId: entry.callId,
          isError: entry.status === 'error',
          summary: outputSummary,
        }
      : undefined,
  );
};

const adaptWebSearchToToolGroup = (
  entry: ITimelineWebSearch,
): TAdaptedToolGroupEntry => {
  const resultSummary = entry.resultsSummary
    ?? (entry.resultCount != null ? `${entry.resultCount} results` : '');

  return toAdaptedToolGroupEntry(
    {
      id: entry.id,
      type: 'tool-call',
      timestamp: entry.timestamp,
      toolUseId: entry.callId,
      toolName: 'WebSearch',
      summary: entry.query ? `WebSearch "${entry.query}"` : 'WebSearch',
      status: entry.status,
    },
    resultSummary
      ? {
          id: `${entry.id}:result`,
          type: 'tool-result',
          timestamp: entry.timestamp,
          toolUseId: entry.callId,
          isError: entry.status === 'error',
          summary: resultSummary,
        }
      : undefined,
  );
};

const adaptMcpToolToToolGroup = (
  entry: ITimelineMcpToolCall,
): TAdaptedToolGroupEntry => toAdaptedToolGroupEntry(
  {
    id: entry.id,
    type: 'tool-call',
    timestamp: entry.timestamp,
    toolUseId: entry.callId,
    toolName: 'MCP',
    summary: `MCP ${entry.server || '?'}/${entry.tool || '?'}`,
    status: entry.status,
  },
  entry.resultSummary
    ? {
        id: `${entry.id}:result`,
        type: 'tool-result',
        timestamp: entry.timestamp,
        toolUseId: entry.callId,
        isError: entry.status === 'error',
        summary: entry.resultSummary,
      }
    : undefined,
);

interface IParsedPatchDiff {
  filePath: string;
  status: string;
  oldString: string;
  newString: string;
  added: number;
  removed: number;
}

const PATCH_FILE_HEADER_RE = /^\*\*\*\s+(Add|Update|Delete)\s+File:\s+(.+?)\s*$/i;
const PATCH_MOVE_TO_RE = /^\*\*\*\s+Move to:\s+(.+?)\s*$/i;

const countDiffLines = (oldStr: string, newStr: string): { added: number; removed: number } => {
  let added = 0;
  let removed = 0;
  for (const change of diffLines(oldStr, newStr)) {
    const count = change.count ?? 0;
    if (change.added) added += count;
    else if (change.removed) removed += count;
  }
  return { added, removed };
};

const parsePatchDiffs = (diff?: string): IParsedPatchDiff[] => {
  if (!diff) return [];

  const parsed: Array<{
    filePath: string;
    status: string;
    oldLines: string[];
    newLines: string[];
    added: number;
    removed: number;
  }> = [];
  let current: (typeof parsed)[number] | null = null;

  const pushCurrent = () => {
    if (!current) return;
    if (current.oldLines.length > 0 || current.newLines.length > 0 || current.added > 0 || current.removed > 0) {
      parsed.push(current);
    }
    current = null;
  };

  for (const line of diff.split('\n')) {
    const header = line.match(PATCH_FILE_HEADER_RE);
    if (header) {
      pushCurrent();
      current = {
        status: header[1].toLowerCase(),
        filePath: header[2],
        oldLines: [],
        newLines: [],
        added: 0,
        removed: 0,
      };
      continue;
    }

    if (!current) continue;

    const moveTo = line.match(PATCH_MOVE_TO_RE);
    if (moveTo) {
      current.filePath = moveTo[1];
      continue;
    }

    if (line.startsWith('@@') || line.startsWith('***')) continue;

    const marker = line[0];
    const value = line.slice(1);
    if (marker === '+') {
      current.newLines.push(value);
      current.added += 1;
    } else if (marker === '-') {
      current.oldLines.push(value);
      current.removed += 1;
    } else if (marker === ' ') {
      current.oldLines.push(value);
      current.newLines.push(value);
    }
  }

  pushCurrent();

  return parsed.map((item) => {
    const oldString = item.oldLines.join('\n');
    const newString = item.newLines.join('\n');
    const { added, removed } = countDiffLines(oldString, newString);
    return {
      filePath: item.filePath,
      status: item.status,
      oldString,
      newString,
      added,
      removed,
    };
  });
};

const patchVerbForStatus = (status: string): string => {
  const s = status.toLowerCase();
  if (s.includes('add') || s.includes('create')) return 'Create';
  if (s.includes('delete') || s.includes('remove')) return 'Delete';
  return 'Update';
};

const adaptPatchApplyToToolGroup = (
  entry: ITimelinePatchApply,
): TAdaptedToolGroupEntry | null => {
  const patchDiffs = parsePatchDiffs(entry.diff);
  if (patchDiffs.length > 0) {
    return {
      calls: patchDiffs.map((patchDiff, idx) => ({
        id: `${entry.id}:${idx}`,
        type: 'tool-call',
        timestamp: entry.timestamp,
        toolUseId: `${entry.callId}:${idx}`,
        toolName: 'Edit',
        summary: `${patchVerbForStatus(patchDiff.status)} ${patchDiff.filePath} (+${patchDiff.added}, -${patchDiff.removed})`,
        filePath: patchDiff.filePath,
        diff: {
          filePath: patchDiff.filePath,
          oldString: patchDiff.oldString,
          newString: patchDiff.newString,
        },
        status: entry.status,
      })),
      results: [],
    };
  }

  const fileCount = entry.files.length;
  if (fileCount === 0 && entry.status === 'success') return { calls: [], results: [] };

  const fileLabel = fileCount === 0
    ? 'files'
    : fileCount === 1
      ? entry.files[0].path
      : pluralize(fileCount, 'file', 'files');

  return toAdaptedToolGroupEntry({
    id: entry.id,
    type: 'tool-call',
    timestamp: entry.timestamp,
    toolUseId: entry.callId,
    toolName: 'Edit',
    summary: `Patch ${fileLabel}`,
    status: entry.status,
  });
};

const adaptToToolGroupEntry = (
  entry: ITimelineEntry,
): TAdaptedToolGroupEntry | null => {
  switch (entry.type) {
    case 'exec-command-stream':
      return adaptExecCommandToToolGroup(entry);
    case 'web-search':
      return adaptWebSearchToToolGroup(entry);
    case 'mcp-tool-call':
      return adaptMcpToolToToolGroup(entry);
    case 'patch-apply':
      return adaptPatchApplyToToolGroup(entry);
    default:
      return null;
  }
};

const groupTimelineEntries = (entries: ITimelineEntry[]): TGroupedItem[] => {
  const result: TGroupedItem[] = [];
  let toolCallBuffer: ITimelineToolCall[] = [];
  let toolResultBuffer: ITimelineToolResult[] = [];

  const flushToolBuffer = () => {
    if (toolCallBuffer.length > 0) {
      result.push({
        type: 'tool-group',
        id: toolCallBuffer[0].id,
        toolCalls: [...toolCallBuffer],
        toolResults: [...toolResultBuffer],
      });
      toolCallBuffer = [];
      toolResultBuffer = [];
    }
  };

  for (const entry of entries) {
    if (entry.type === 'tool-call') {
      toolCallBuffer.push(entry);
    } else if (entry.type === 'tool-result') {
      toolResultBuffer.push(entry);
    } else {
      const adapted = adaptToToolGroupEntry(entry);
      if (adapted) {
        toolCallBuffer.push(...adapted.calls);
        toolResultBuffer.push(...adapted.results);
        continue;
      }
      flushToolBuffer();
      result.push({ type: 'entry', id: entry.id, entry });
    }
  }

  flushToolBuffer();
  return result;
};

const InterruptItem = () => {
  const t = useTranslations('timeline');
  return (
    <div className="flex items-center justify-end gap-1.5 py-1 text-xs text-muted-foreground/60">
      <OctagonX size={12} />
      <span>{t('requestCancelled')}</span>
    </div>
  );
};

const SessionExitItem = () => {
  const t = useTranslations('timeline');
  return (
    <div className="flex items-center justify-end gap-1.5 py-1 text-xs text-muted-foreground/60">
      <LogOut size={12} />
      <span>{t('sessionExit')}</span>
    </div>
  );
};

const TimelineEntryRenderer = ({ entry, sessionName }: { entry: ITimelineEntry; sessionName?: string }) => {
  switch (entry.type) {
    case 'user-message':
      return <UserMessageItem entry={entry} />;
    case 'assistant-message':
      return <AssistantMessageItem entry={entry} />;
    case 'agent-group':
      return <AgentGroupItem entry={entry} />;
    case 'task-notification':
      return <TaskNotificationItem entry={entry} />;
    case 'plan':
      return <PlanItem entry={entry} sessionName={sessionName} />;
    case 'ask-user-question':
      return <AskUserQuestionItem entry={entry} sessionName={sessionName} />;
    case 'task-progress':
      return <TaskProgressItem entry={entry} />;
    case 'interrupt':
      return <InterruptItem />;
    case 'session-exit':
      return <SessionExitItem />;
    case 'approval-request':
      return <ApprovalRequestItem entry={entry} />;
    case 'exec-command-stream':
      return <ExecCommandStreamItem entry={entry} />;
    case 'web-search':
      return <WebSearchItem entry={entry} />;
    case 'mcp-tool-call':
      return <McpToolCallItem entry={entry} />;
    case 'patch-apply':
      return <PatchApplyItem entry={entry} />;
    case 'context-compacted':
      return <ContextCompactedItem entry={entry} />;
    case 'reasoning-summary':
      return null;
    case 'error-notice':
      return <ErrorNoticeItem entry={entry} />;
    default:
      return null;
  }
};

const SkeletonLoader = () => (
  <div className="mx-auto max-w-content">
    <div className="animate-delayed-fade-in flex flex-col gap-4 p-4">
      {[48, 36, 40].map((w, i) => (
        <div key={i} className="flex flex-col gap-2">
          <div className="h-4 animate-pulse rounded bg-claude-active/20" style={{ width: `${w}%` }} />
          <div className="h-4 animate-pulse rounded bg-claude-active/20" style={{ width: `${w - 10}%` }} />
        </div>
      ))}
    </div>
  </div>
);

const ErrorState = ({ error, onRetry, showRefresh }: { error: string; onRetry: () => void; showRefresh?: boolean }) => {
  const t = useTranslations('timeline');
  const tc = useTranslations('common');
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <Terminal size={32} className="opacity-40" />
      <div className="text-center">
        <p className="text-sm font-medium">{t('connectionError')}</p>
        <p className="mt-1 text-xs">{error}</p>
      </div>
      <Button variant="outline" size="xs" onClick={onRetry}>
        <RefreshCw size={12} />
        {tc('retry')}
      </Button>
      {showRefresh && (
        <Button variant="ghost" size="xs" onClick={() => reloadForReconnectRecovery('timeline')}>
          <RefreshCw size={12} />
          {tc('refresh')}
        </Button>
      )}
    </div>
  );
};

const ReconnectBanner = () => {
  const t = useTranslations('timeline');
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground shadow-sm">
        <Spinner size={10} />
        {t('reconnecting')}
      </div>
    </div>
  );
};

const DisconnectedBanner = ({ onRetry }: { onRetry: () => void }) => {
  const t = useTranslations('timeline');
  const tc = useTranslations('common');
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground shadow-sm">
        <span>{t('connectionFailed')}</span>
        <Button variant="outline" size="xs" className="h-5 rounded-full px-2 text-xs" onClick={onRetry}>
          {tc('retry')}
        </Button>
      </div>
    </div>
  );
};

const EmptyState = () => {
  const t = useTranslations('timeline');

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <MessageSquareMore size={32} className="opacity-40" />
      <p className="text-xs">{t('emptyRunning')}</p>
    </div>
  );
};

const TimelineView = ({
  entries,
  tasks,
  sessionId,
  sessionName,
  tabId,
  initMeta,
  sessionStats,
  cliState,
  compactingSince,
  wsStatus,
  isLoading,
  error,
  onRetry,
  onLoadMore,
  hasMore,
  scrollToBottomRef,
  active = true,
}: ITimelineViewProps) => {
  const t = useTranslations('timeline');
  const needsInput = cliState === 'needs-input';
  const isCompacting = compactingSince != null && Date.now() - compactingSince < 60_000;
  const anchorElRef = useRef<HTMLDivElement | null>(null);
  const spacerRef = useRef<HTMLDivElement | null>(null);
  const bottomSentinelRef = useRef<HTMLDivElement | null>(null);
  const armedRef = useRef(false);
  const wasBusyRef = useRef(false);
  const pendingShrinkRef = useRef(false);
  const { scrollRef, contentRef, scrollToBottom } = useStickToBottom({
    resize: { damping: 0.8, stiffness: 0.05 },
    initial: 'instant',
    targetScrollTop: (defaultTarget, { scrollElement }) => {
      const el = anchorElRef.current;
      if (!el) return defaultTarget;
      return getOffsetInScroller(el, scrollElement) - ANCHOR_OFFSET;
    },
  });
  const [anchorUserId, setAnchorUserId] = useState<string | null>(null);
  const [spacerHeight, setSpacerHeight] = useState(0);
  const [skipAnimation, setSkipAnimation] = useState(true);
  const [prevSessionId, setPrevSessionId] = useState(sessionId);
  const [hasOverflowBelow, setHasOverflowBelow] = useState(false);

  const hasPendingUserMessage = entries.some((entry) => entry.type === 'user-message' && entry.pending === true);

  if (prevSessionId !== sessionId) {
    setPrevSessionId(sessionId);
    if (!hasPendingUserMessage) {
      setSkipAnimation(true);
      setAnchorUserId(null);
    }
    armedRef.current = false;
    wasBusyRef.current = false;
    pendingShrinkRef.current = false;
  }

  useEffect(() => {
    if (!scrollToBottomRef) return;
    scrollToBottomRef.current = () => {
      armedRef.current = true;
      scrollToBottom('smooth');
      setTimeout(() => scrollToBottom('smooth'), ANCHOR_SETTLE_DELAY_MS);
    };
    return () => { scrollToBottomRef.current = undefined; };
  }, [scrollToBottomRef, scrollToBottom]);

  const groupedItems = useMemo(() => groupTimelineEntries(entries), [entries]);
  const hasDisplayItems = groupedItems.length > 0;

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const matchIds = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [] as string[];
    return groupedItems
      .filter((item) => {
        const text = item.type === 'tool-group'
          ? [...item.toolCalls, ...item.toolResults].map(getEntryText).join(' ')
          : getEntryText(item.entry);
        return text.toLowerCase().includes(q);
      })
      .map((item) => item.id);
  }, [groupedItems, searchQuery]);

  const currentMatchId = matchIds[matchIndex] ?? null;

  const handleSearchQueryChange = useCallback((value: string) => {
    setSearchQuery(value);
    setMatchIndex(0);
  }, []);

  const nextMatch = useCallback(() => {
    setMatchIndex((i) => (matchIds.length === 0 ? 0 : (i + 1) % matchIds.length));
  }, [matchIds.length]);

  const prevMatch = useCallback(() => {
    setMatchIndex((i) => (matchIds.length === 0 ? 0 : (i - 1 + matchIds.length) % matchIds.length));
  }, [matchIds.length]);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
    setMatchIndex(0);
  }, []);

  useHotkeys(
    'mod+f',
    () => {
      setSearchOpen(true);
      requestAnimationFrame(() => searchInputRef.current?.select());
    },
    { enableOnFormTags: true, preventDefault: true, enabled: active },
  );

  useEffect(() => {
    if (!active && searchOpen) closeSearch();
  }, [active, searchOpen, closeSearch]);

  useEffect(() => {
    if (!searchOpen || !currentMatchId) return;
    const root = scrollRef.current;
    const card = root?.querySelector(`[data-timeline-item="${CSS.escape(currentMatchId)}"]`);
    if (!root || !(card instanceof HTMLElement)) return;
    // 카드가 아니라 카드 안 첫 매치 키워드를 뷰 중앙으로 올려 눈이 바로 단어에 닿게 한다
    const needle = searchQuery.trim().toLowerCase();
    const range = needle ? firstMatchRange(card, needle) : null;
    const rect = range?.getBoundingClientRect();
    if (rect && rect.height > 0) {
      const rootRect = root.getBoundingClientRect();
      const target = rect.top - rootRect.top + root.scrollTop - root.clientHeight / 2;
      root.scrollTop = Math.max(0, target);
    } else {
      card.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  }, [currentMatchId, searchOpen, searchQuery, scrollRef]);

  useTimelineSearchHighlight({
    scrollRef,
    query: searchQuery,
    enabled: searchOpen && active,
    currentMatchId,
    revision: groupedItems,
  });

  const lastUserMessageId = useMemo(
    () => groupedItems.findLast((item) => item.type === 'entry' && item.entry.type === 'user-message')?.id ?? null,
    [groupedItems],
  );

  useEffect(() => {
    if (armedRef.current && lastUserMessageId && lastUserMessageId !== anchorUserId) {
      setAnchorUserId(lastUserMessageId);
      armedRef.current = false;
      return;
    }
    if (anchorUserId && lastUserMessageId && lastUserMessageId !== anchorUserId) {
      const anchorExists = entries.some((e) => e.id === anchorUserId);
      if (!anchorExists) setAnchorUserId(lastUserMessageId);
    }
  }, [lastUserMessageId, anchorUserId, entries]);

  const [shouldProbeResumeDialog, setShouldProbeResumeDialog] = useState(false);
  const currentContextTokens = sessionStats?.currentContextTokens ?? 0;
  const resumeProbeDepsKey = `${cliState}:${currentContextTokens}:${initMeta?.lastTimestamp ?? 0}:${sessionName ?? ''}`;

  useEffect(() => {
    if (cliState !== 'idle' || !initMeta || !sessionName
      || currentContextTokens < RESUME_TOKEN_THRESHOLD
      || !initMeta.lastTimestamp) {
      setShouldProbeResumeDialog(false);
      return;
    }

    const check = () => {
      const idleMinutes = (Date.now() - initMeta.lastTimestamp) / 60_000;
      setShouldProbeResumeDialog(idleMinutes >= RESUME_IDLE_MINUTES);
    };
    check();
    const id = setInterval(check, 60_000);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumeProbeDepsKey]);

  useEffect(() => {
    if (skipAnimation && entries.length > 0) {
      scrollToBottom('instant');
      requestAnimationFrame(() => setSkipAnimation(false));
    }
  }, [skipAnimation, entries.length, scrollToBottom]);

  const measureSpacer = useCallback(() => {
    const scrollEl = scrollRef.current;
    const userEl = anchorElRef.current;
    const spacerEl = spacerRef.current;
    if (!scrollEl || !userEl || !spacerEl) return;
    const userBottom = userEl.offsetTop + userEl.offsetHeight;
    const postUserHeight = Math.max(0, spacerEl.offsetTop - userBottom);
    const available = scrollEl.clientHeight - userEl.offsetHeight - ANCHOR_OFFSET;
    const next = Math.max(0, available - postUserHeight);
    setSpacerHeight((prev) => (prev === next ? prev : next));
  }, [scrollRef]);

  const shrinkSpacerSafely = useCallback(() => {
    const scrollEl = scrollRef.current;
    const userEl = anchorElRef.current;
    const spacerEl = spacerRef.current;
    if (!scrollEl || !userEl || !spacerEl) return;
    const current = spacerEl.offsetHeight;
    if (current === 0) return;
    const scrollTop = scrollEl.scrollTop;
    const userBottom = userEl.offsetTop + userEl.offsetHeight;
    const postUserHeight = Math.max(0, spacerEl.offsetTop - userBottom);
    const available = scrollEl.clientHeight - userEl.offsetHeight - ANCHOR_OFFSET;
    const pinRemainder = Math.max(0, available - postUserHeight);
    const pin = Math.max(0, getOffsetInScroller(userEl, scrollEl) - ANCHOR_OFFSET);
    const atPin = scrollTop >= pin - 2;
    const target = atPin ? pinRemainder : 0;
    if (current <= target) return;
    const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
    const headroom = Math.max(0, maxScroll - scrollTop);
    const shrinkBy = Math.min(current - target, headroom);
    if (shrinkBy <= 0) return;
    setSpacerHeight(current - shrinkBy);
  }, [scrollRef]);

  const scheduleShrinkSpacerSafely = useCallback(() => {
    if (!anchorUserId || cliState === 'busy') return;
    pendingShrinkRef.current = true;
    requestAnimationFrame(() => {
      shrinkSpacerSafely();
      setTimeout(shrinkSpacerSafely, ANCHOR_SETTLE_DELAY_MS);
    });
  }, [anchorUserId, cliState, shrinkSpacerSafely]);

  useLayoutEffect(() => {
    wasBusyRef.current = false;
    pendingShrinkRef.current = false;
    if (!anchorUserId) {
      setSpacerHeight(0);
      return;
    }
    measureSpacer();
  }, [anchorUserId, measureSpacer]);

  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    const ro = new ResizeObserver(() => measureSpacer());
    ro.observe(scrollEl);
    return () => ro.disconnect();
  }, [scrollRef, measureSpacer]);

  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl) return;
    const ro = new ResizeObserver(() => {
      if (pendingShrinkRef.current) shrinkSpacerSafely();
    });
    ro.observe(contentEl);
    return () => ro.disconnect();
  }, [contentRef, shrinkSpacerSafely]);

  useEffect(() => {
    if (!anchorUserId) return;
    if (cliState === 'busy') {
      wasBusyRef.current = true;
      pendingShrinkRef.current = false;
      return;
    }
    if (wasBusyRef.current) {
      wasBusyRef.current = false;
      pendingShrinkRef.current = true;
    } else if (!pendingShrinkRef.current) {
      const lastUserIdx = entries.findLastIndex((e) => e.id === anchorUserId);
      if (lastUserIdx >= 0 && entries.length > lastUserIdx + 1) {
        pendingShrinkRef.current = true;
      }
    }
    if (pendingShrinkRef.current) {
      shrinkSpacerSafely();
    }
  }, [cliState, anchorUserId, entries, shrinkSpacerSafely]);

  useEffect(() => {
    const handleVisible = () => {
      if (document.visibilityState === 'hidden') return;
      scheduleShrinkSpacerSafely();
    };

    document.addEventListener('visibilitychange', handleVisible);
    window.addEventListener('focus', handleVisible);
    window.addEventListener('pageshow', handleVisible);
    return () => {
      document.removeEventListener('visibilitychange', handleVisible);
      window.removeEventListener('focus', handleVisible);
      window.removeEventListener('pageshow', handleVisible);
    };
  }, [scheduleShrinkSpacerSafely]);

  const canObserveOverflow = !isLoading && !error && hasDisplayItems && !skipAnimation;
  useEffect(() => {
    if (!canObserveOverflow) return;
    const scrollEl = scrollRef.current;
    const sentinel = bottomSentinelRef.current;
    if (!scrollEl || !sentinel) return;

    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setHasOverflowBelow(false);
          return;
        }
        const root = entry.rootBounds;
        const target = entry.boundingClientRect;
        setHasOverflowBelow(!!root && target.top >= root.bottom);
      },
      { root: scrollEl, threshold: 0, rootMargin: OVERFLOW_SENTINEL_ROOT_MARGIN },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [canObserveOverflow, scrollRef]);

  const isLoadingMoreRef = useRef(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const needsManualAnchor = typeof CSS !== 'undefined' && !CSS.supports?.('overflow-anchor', 'auto');
  const scrollAnchorRef = useRef<{ scrollHeight: number } | null>(null);

  const triggerLoadMore = useCallback(() => {
    if (!hasMore || isLoadingMoreRef.current) return;
    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);

    if (needsManualAnchor) {
      const scrollEl = scrollRef.current;
      if (scrollEl) {
        scrollAnchorRef.current = { scrollHeight: scrollEl.scrollHeight };
      }
    }

    onLoadMore().finally(() => {
      isLoadingMoreRef.current = false;
      setIsLoadingMore(false);
    });
  }, [hasMore, onLoadMore, scrollRef, needsManualAnchor]);

  useLayoutEffect(() => {
    if (!needsManualAnchor) return;

    const anchor = scrollAnchorRef.current;
    const scrollEl = scrollRef.current;
    if (!anchor || !scrollEl || isLoadingMore) return;

    const heightDiff = scrollEl.scrollHeight - anchor.scrollHeight;
    if (heightDiff > 0) {
      scrollEl.scrollTop += heightDiff;
    }
    scrollAnchorRef.current = null;
  }, [isLoadingMore, scrollRef, needsManualAnchor]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          triggerLoadMore();
        }
      },
      { root, rootMargin: '200px 0px 0px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [scrollRef, triggerLoadMore]);

  if (isLoading && wsStatus === 'disconnected') {
    return (
      <ErrorState
        error={t('connectionFailed')}
        onRetry={onRetry}
        showRefresh={shouldPromptMobileReloadRecovery()}
      />
    );
  }

  if (isLoading) {
    return <SkeletonLoader />;
  }

  if (error) {
    return <ErrorState error={error} onRetry={onRetry} />;
  }

  if (!hasDisplayItems) {
    return <EmptyState />;
  }

  const isReconnecting = wsStatus === 'reconnecting';
  const isDisconnected = wsStatus === 'disconnected';

  return (
    <div className="relative flex h-full flex-col">
      {searchOpen && (
        <TimelineSearchBar
          query={searchQuery}
          onQueryChange={handleSearchQueryChange}
          matchCount={matchIds.length}
          currentIndex={matchIndex}
          onNext={nextMatch}
          onPrev={prevMatch}
          onClose={closeSearch}
          inputRef={searchInputRef}
        />
      )}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto py-2 transition-opacity"
        style={{
          opacity: skipAnimation ? 0 : 1,
          transitionDuration: '300ms',
        }}
        tabIndex={0}
        role="log"
        aria-label={t('timelineAria')}
      >
        <div ref={contentRef} className="mx-auto max-w-content">
          {hasMore && <div ref={sentinelRef} className="h-px" />}
          {hasMore && !isLoadingMore && (
            <div className="flex justify-center py-2">
              <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={triggerLoadMore}>
                <ChevronsUp size={12} className="mr-1" />
                {t('loadMore')}
              </Button>
            </div>
          )}
          {isLoadingMore && (
            <div className="flex flex-col gap-3 px-4 py-3">
              {[44, 32, 48].map((w, i) => (
                <div key={i} className="flex flex-col gap-1.5">
                  <div className="h-3.5 animate-pulse rounded bg-muted/60" style={{ width: `${w}%` }} />
                  <div className="h-3.5 animate-pulse rounded bg-muted/60" style={{ width: `${w - 12}%` }} />
                </div>
              ))}
            </div>
          )}
          {tasks.length > 0 && (
            <TaskChecklist tasks={tasks} cliState={cliState} />
          )}
          {groupedItems.map((item) => (
            <div
              key={item.id}
              ref={item.id === anchorUserId ? anchorElRef : undefined}
              data-timeline-item={item.id}
              className={cn(
                'px-4 py-1.5',
                searchOpen && item.id === currentMatchId && 'rounded-md bg-claude-active/5 ring-2 ring-claude-active/40',
              )}
            >
              {item.type === 'tool-group' ? (
                <ToolGroupItem toolCalls={item.toolCalls} toolResults={item.toolResults} />
              ) : (
                <TimelineEntryRenderer entry={item.entry} sessionName={sessionName} />
              )}
            </div>
          ))}
          {(shouldProbeResumeDialog || needsInput) && sessionName && (
            <div className="px-4 py-1.5">
              <PermissionPromptItem
                sessionName={sessionName}
                tabId={tabId}
                silent={shouldProbeResumeDialog && !needsInput}
              />
            </div>
          )}
          {cliState === 'busy' && !needsInput && (
            <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
              <Spinner size={10} className="text-claude-active" />
              <ElapsedTime since={entries[entries.length - 1].timestamp} />
            </div>
          )}
          {isCompacting && (
            <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
              <Spinner size={10} className="text-claude-active" />
              <span>{t('contextCompacting')}</span>
            </div>
          )}
          <div ref={bottomSentinelRef} aria-hidden style={{ height: 0, overflowAnchor: 'none' }} />
          {/* overflow-anchor: none prevents the browser from anchoring scroll to this spacer when its height changes */}
          <div ref={spacerRef} aria-hidden style={{ height: spacerHeight, overflowAnchor: 'none' }} />
        </div>
      </div>
      {isReconnecting && <ReconnectBanner />}
      {isDisconnected && <DisconnectedBanner onRetry={onRetry} />}
      <ScrollToBottomButton
        visible={hasOverflowBelow}
        onClick={() => {
          const el = scrollRef.current;
          if (!el) return;
          const spacerH = spacerRef.current?.offsetHeight ?? 0;
          el.scrollTo({ top: el.scrollHeight - spacerH, behavior: 'smooth' });
        }}
      />
    </div>
  );
};

export default TimelineView;
