import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type {
  ITimelineEntry,
  IInitMeta,
  ISessionStats,
  ITaskItem,
  TCliState,
  TTimelineConnectionStatus,
} from '@/types/timeline';
import useTimelineWebSocket from '@/hooks/use-timeline-websocket';
import { appendTimelineEntries } from '@/lib/timeline-append';

interface IResumeCallbacks {
  onResumeStarted?: (payload: { sessionId: string; jsonlPath: string | null }) => void;
  onResumeBlocked?: (payload: { reason: string; processName?: string }) => void;
  onResumeError?: (payload: { message: string }) => void;
}

export interface ITimelineSyncState {
  agentProcess: boolean | null;
  agentInstalled: boolean;
  isLoading: boolean;
}

interface IUseTimelineOptions {
  sessionName: string;
  agentSessionId?: string | null;
  claudeSessionId?: string | null;
  panelType?: 'claude-code' | 'codex-cli';
  enabled: boolean;
  resumeCallbacks?: IResumeCallbacks;
  onSync?: (state: ITimelineSyncState) => void;
  getCliState?: () => TCliState | undefined;
}

const PENDING_AUTOHIDE_DELAY_MS = 1000;
const PENDING_FADE_OUT_DURATION_MS = 200;
const ATTACHMENT_PLACEHOLDER_TIMEOUT_MS = 60_000;

const normalizeUserMessageText = (s: string) => s.replace(/\s+/g, ' ').trim();

interface IUseTimelineReturn {
  entries: ITimelineEntry[];
  tasks: ITaskItem[];
  sessionId: string | null;
  jsonlPath: string | null;
  sessionSummary: string | undefined;
  initMeta: IInitMeta | undefined;
  sessionStats: ISessionStats | null;
  agentProcess: boolean | null;
  agentInstalled: boolean;
  wsStatus: TTimelineConnectionStatus;
  isLoading: boolean;
  error: string | null;
  loadMore: () => Promise<void>;
  hasMore: boolean;
  retrySession: () => void;
  sendResume: (sessionId: string, tmuxSession: string) => void;
  addPendingUserMessage: (text: string, options?: { autoHide?: boolean; attachmentPlaceholder?: boolean }) => string;
  removePendingUserMessage: (id: string) => void;
}

const useTimeline = ({
  sessionName,
  agentSessionId,
  claudeSessionId,
  panelType,
  enabled,
  resumeCallbacks,
  onSync,
  getCliState,
}: IUseTimelineOptions): IUseTimelineReturn => {
  const [entries, setEntries] = useState<ITimelineEntry[]>([]);
  const [agentProcess, setAgentProcess] = useState<boolean | null>(null);
  const [agentInstalled, setAgentInstalled] = useState(true);
  const [wsInitReceived, setWsInitReceived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionSummary, setSessionSummary] = useState<string | undefined>();
  const [initMeta, setInitMeta] = useState<IInitMeta | undefined>();
  const [sessionStats, setSessionStats] = useState<ISessionStats | null>(null);
  const [jsonlPath, setJsonlPath] = useState<string | null>(null);

  const entriesRef = useRef(entries);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  const jsonlPathRef = useRef<string | null>(null);
  const startByteOffsetRef = useRef(0);
  const isLoadingMoreRef = useRef(false);

  const getCliStateRef = useRef(getCliState);
  useEffect(() => {
    getCliStateRef.current = getCliState;
  }, [getCliState]);

  const [prevSessionName, setPrevSessionName] = useState(sessionName);
  if (sessionName !== prevSessionName) {
    setPrevSessionName(sessionName);
    setWsInitReceived(false);
    setAgentProcess(null);
    setAgentInstalled(true);
    setEntries([]);
    setError(null);
    setHasMore(false);
    setSessionId(null);
    setSessionSummary(undefined);
    setInitMeta(undefined);
    setSessionStats(null);
    setJsonlPath(null);
    jsonlPathRef.current = null;
    startByteOffsetRef.current = 0;
  }

  const isLoading = !wsInitReceived && entries.length === 0;

  const handleInit = useCallback((newEntries: ITimelineEntry[], _totalEntries: number, initSessionId: string, summary?: string, meta?: IInitMeta, startByteOffset?: number, hasMoreInit?: boolean, jsonlPath?: string | null, isClaudeStarting?: boolean, initStats?: ISessionStats | null) => {
    setWsInitReceived(true);
    setAgentInstalled(true);
    setEntries((prev) => {
      const pendings = prev.filter(
        (e): e is ITimelineEntry & { type: 'user-message'; pending: true } =>
          e.type === 'user-message' && e.pending === true,
      );
      if (pendings.length === 0) return newEntries;

      const merged = newEntries.map((entry) => {
        if (entry.type !== 'user-message') return entry;
        const target = entry.text.trim();
        const matchIdx = pendings.findIndex((p) => p.text.trim() === target);
        if (matchIdx === -1) return entry;
        const matched = pendings[matchIdx];
        pendings.splice(matchIdx, 1);
        return { ...entry, id: matched.id };
      });
      return [...merged, ...pendings];
    });
    startByteOffsetRef.current = startByteOffset ?? 0;
    setHasMore(hasMoreInit ?? false);
    setSessionSummary(summary);
    setInitMeta(meta);
    setSessionStats(initStats ?? null);
    if (jsonlPath) {
      jsonlPathRef.current = jsonlPath;
      setJsonlPath(jsonlPath);
    }
    if (initSessionId) {
      setSessionId(initSessionId);
    } else if (!isClaudeStarting) {
      setAgentProcess(false);
    }
    setError(null);
  }, []);

  const handleAppend = useCallback((newEntries: ITimelineEntry[]) => {
    setEntries((prev) => appendTimelineEntries(prev, newEntries));
  }, []);

  const addPendingUserMessage = useCallback((text: string, options?: { autoHide?: boolean; attachmentPlaceholder?: boolean }): string => {
    const trimmed = text.trim();
    const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (!trimmed) return id;
    const pendingEntry: ITimelineEntry = {
      id,
      type: 'user-message',
      timestamp: Date.now(),
      text: trimmed,
      pending: true,
      attachmentPlaceholder: options?.attachmentPlaceholder,
    };
    setEntries((prev) => [...prev, pendingEntry]);

    if (options?.attachmentPlaceholder) {
      setTimeout(() => {
        setEntries((prev) =>
          prev.filter(
            (e) => !(e.id === id && e.type === 'user-message' && e.pending === true && e.attachmentPlaceholder === true),
          ),
        );
      }, ATTACHMENT_PLACEHOLDER_TIMEOUT_MS);
    } else if (options?.autoHide !== false) {
      setTimeout(() => {
        if (getCliStateRef.current?.() !== 'busy') return;
        setEntries((prev) =>
          prev.some((e) => e.id !== id)
            ? prev.map((e) =>
                e.id === id && e.type === 'user-message' && e.pending === true
                  ? { ...e, fadingOut: true }
                  : e,
              )
            : prev,
        );
        setTimeout(() => {
          setEntries((prev) => {
            if (!prev.some((e) => e.id !== id)) return prev;
            return prev.filter(
              (e) => !(e.id === id && e.type === 'user-message' && e.pending === true),
            );
          });
        }, PENDING_FADE_OUT_DURATION_MS);
      }, PENDING_AUTOHIDE_DELAY_MS);
    }
    return id;
  }, []);

  const removePendingUserMessage = useCallback((id: string) => {
    setEntries((prev) =>
      prev.filter(
        (e) => !(e.id === id && e.type === 'user-message' && e.pending === true),
      ),
    );
  }, []);

  const handleSessionChanged = useCallback((newSessionId: string, reason: string) => {
    if (reason === 'session-ended') {
      setAgentProcess(false);
      setWsInitReceived(true);
      setEntries([]);
      setSessionSummary(undefined);
      setInitMeta(undefined);
      setSessionStats(null);
      setHasMore(false);
      return;
    }
    if (reason === 'session-waiting') {
      if (newSessionId) {
        setAgentProcess(true);
        setSessionId(newSessionId);
      } else {
        setAgentProcess(true);
      }
      return;
    }
    setSessionId(newSessionId || null);
    setAgentProcess(true);
    setEntries((prev) =>
      prev.filter(
        (e): e is ITimelineEntry & { type: 'user-message'; pending: true } =>
          e.type === 'user-message' && e.pending === true,
      ),
    );
    setSessionSummary(undefined);
    setInitMeta(undefined);
    setSessionStats(null);
    setHasMore(false);
    setWsInitReceived(false);
  }, []);

  const handleStatsUpdate = useCallback((stats: ISessionStats) => {
    setSessionStats(stats);
  }, []);

  const loadMore = useCallback(async () => {
    if (!jsonlPathRef.current || isLoadingMoreRef.current || !hasMore) return;
    if (startByteOffsetRef.current <= 0) {
      setHasMore(false);
      return;
    }
    isLoadingMoreRef.current = true;
    try {
      const res = await fetch(
        `/api/timeline/entries?jsonlPath=${encodeURIComponent(jsonlPathRef.current)}&beforeByte=${startByteOffsetRef.current}&limit=256`,
      );
      if (!res.ok) return;
      const data = await res.json();
      const loadedEntries = data.entries as ITimelineEntry[];
      setEntries((prev) => {
        if (!data.replaceEntries) return [...loadedEntries, ...prev];

        const pendings = prev.filter(
          (e): e is ITimelineEntry & { type: 'user-message'; pending: true } =>
            e.type === 'user-message' && e.pending === true,
        );
        if (pendings.length === 0) return loadedEntries;

        const unmatchedPendings = [...pendings];
        const merged = loadedEntries.map((entry) => {
          if (entry.type !== 'user-message') return entry;
          const target = normalizeUserMessageText(entry.text);
          const matchIdx = unmatchedPendings.findIndex(
            (pending) => pending.attachmentPlaceholder || normalizeUserMessageText(pending.text) === target,
          );
          if (matchIdx === -1) return entry;
          const matched = unmatchedPendings[matchIdx];
          unmatchedPendings.splice(matchIdx, 1);
          return { ...entry, id: matched.id };
        });

        return [...merged, ...unmatchedPendings];
      });
      startByteOffsetRef.current = data.startByteOffset;
      setHasMore(data.hasMore);
    } finally {
      isLoadingMoreRef.current = false;
    }
  }, [hasMore]);

  const handleError = useCallback((err: { code: string; message: string }) => {
    if (err.code === 'not-installed') {
      setAgentInstalled(false);
      return;
    }
    console.warn(`[timeline] WebSocket error: ${err.code} — ${err.message}`);
  }, []);

  const resumeCallbacksRef = useRef(resumeCallbacks);
  useEffect(() => {
    resumeCallbacksRef.current = resumeCallbacks;
  }, [resumeCallbacks]);

  const handleResumeStarted = useCallback(
    (payload: { sessionId: string; jsonlPath: string | null }) => {
      if (payload.jsonlPath) {
        jsonlPathRef.current = payload.jsonlPath;
      }
      setSessionId(payload.sessionId);
      setAgentProcess(true);
      setEntries([]);
      setWsInitReceived(false);
      resumeCallbacksRef.current?.onResumeStarted?.(payload);
    },
    [],
  );

  const handleResumeBlocked = useCallback(
    (payload: { reason: string; processName?: string }) => {
      resumeCallbacksRef.current?.onResumeBlocked?.(payload);
    },
    [],
  );

  const handleResumeError = useCallback(
    (payload: { message: string }) => {
      resumeCallbacksRef.current?.onResumeError?.(payload);
    },
    [],
  );

  const { status: wsStatus, reconnect, sendResume } = useTimelineWebSocket({
    sessionName,
    agentSessionId,
    claudeSessionId,
    panelType,
    enabled,
    onInit: handleInit,
    onAppend: handleAppend,
    onSessionChanged: handleSessionChanged,
    onStatsUpdate: handleStatsUpdate,
    onError: handleError,
    onResumeStarted: handleResumeStarted,
    onResumeBlocked: handleResumeBlocked,
    onResumeError: handleResumeError,
  });

  const retrySession = useCallback(() => {
    setError(null);
    reconnect();
  }, [reconnect]);

  const onSyncRef = useRef(onSync);
  useEffect(() => { onSyncRef.current = onSync; }, [onSync]);

  useEffect(() => {
    onSyncRef.current?.({ agentProcess, agentInstalled, isLoading });
  }, [agentProcess, agentInstalled, isLoading]);

  const tasks = useMemo((): ITaskItem[] => {
    const items: ITaskItem[] = [];
    let createIndex = 0;

    for (const entry of entries) {
      if (entry.type !== 'task-progress') continue;

      if (entry.action === 'create') {
        createIndex++;
        items.push({
          taskId: entry.taskId || String(createIndex),
          subject: entry.subject ?? '',
          description: entry.description,
          status: entry.status,
        });
      } else if (entry.action === 'update') {
        const target = items.find((t) => t.taskId === entry.taskId);
        if (target) {
          target.status = entry.status;
        }
      }
    }

    return items;
  }, [entries]);

  return {
    entries,
    tasks,
    sessionId,
    jsonlPath,
    sessionSummary,
    initMeta,
    sessionStats,
    agentProcess,
    agentInstalled,
    wsStatus,
    isLoading,
    error,
    loadMore,
    hasMore,
    retrySession,
    sendResume,
    addPendingUserMessage,
    removePendingUserMessage,
  };
};

export default useTimeline;
