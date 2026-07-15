import { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import Spinner from '@/components/ui/spinner';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import useTimeline from '@/hooks/use-timeline';
import useSessionList from '@/hooks/use-session-list';
import useStartingPrompt from '@/hooks/use-starting-prompt';
import useTabStore, { selectSessionView } from '@/hooks/use-tab-store';
import { useSessionMetaCompute } from '@/hooks/use-session-meta';
import SessionListView from '@/components/features/workspace/session-list-view';
import SessionEmptyView from '@/components/features/workspace/session-empty-view';
import AgentBootProgress from '@/components/features/workspace/agent-boot-progress';
import BypassPromptCard from '@/components/features/workspace/bypass-prompt-card';
import TrustPromptCard from '@/components/features/workspace/trust-prompt-card';
import TimelineView from '@/components/features/timeline/timeline-view';
import ClaudeLogo from '@/components/icons/claude-logo';
import type { ITrustPromptInfo, TTrustAnswer } from '@/lib/trust-prompt-detector';
import SessionMetaBar, { SessionMetaBarSkeleton } from '@/components/features/workspace/session-meta-bar';

interface IClaudeCodePanelProps {
  tabId: string;
  sessionName: string;
  claudeSessionId?: string | null;
  cwd?: string;
  className?: string;
  active?: boolean;
  onClose?: () => void;
  onNewSession?: () => void;
  scrollToBottomRef?: React.MutableRefObject<(() => void) | undefined>;
  addPendingMessageRef?: React.MutableRefObject<((text: string, options?: { autoHide?: boolean; attachmentPlaceholder?: boolean }) => string) | undefined>;
  removePendingMessageRef?: React.MutableRefObject<((id: string) => void) | undefined>;
  trustPrompt?: ITrustPromptInfo | null;
  onTrustResponse?: (answer: TTrustAnswer) => void;
}

const ClaudeCodePanel = ({
  tabId,
  sessionName,
  claudeSessionId,
  cwd,
  className,
  active,
  onClose,
  onNewSession,
  scrollToBottomRef,
  addPendingMessageRef,
  removePendingMessageRef,
  trustPrompt,
  onTrustResponse,
}: IClaudeCodePanelProps) => {
  const t = useTranslations('terminal');
  const [resumingSessionId, setResumingSessionId] = useState<string | null>(null);

  const agentProcess = useTabStore((s) => s.tabs[tabId]?.agentProcess ?? null);
  const agentInstalled = useTabStore((s) => s.tabs[tabId]?.agentInstalled ?? true);
  const storeCliState = useTabStore((s) => s.tabs[tabId]?.cliState ?? 'inactive');
  const compactingSince = useTabStore((s) => s.tabs[tabId]?.compactingSince ?? null);
  const view = useTabStore((s) => selectSessionView(s.tabs, tabId));
  const cachedSessionMeta = useTabStore((s) => s.tabs[tabId]?.sessionMetaCache ?? null);
  const tabClaudeSummary = useTabStore((s) => s.tabs[tabId]?.agentSummary ?? null);
  const tabLastUserMessage = useTabStore((s) => s.tabs[tabId]?.lastUserMessage ?? null);

  const handleResumeStarted = useCallback(
    () => {
      setResumingSessionId(null);
    },
    [],
  );

  const handleResumeBlocked = useCallback(
    (payload: { reason: string; processName?: string }) => {
      setResumingSessionId(null);
      toast.warning(t('resumeBlocked'), {
        description: payload.processName
          ? t('resumeBlockedProcess', { name: payload.processName })
          : undefined,
      });
    },
    [t],
  );

  const handleResumeError = useCallback(() => {
    setResumingSessionId(null);
    toast.error(t('resumeFailed'));
  }, [t]);

  const {
    entries,
    tasks,
    sessionId,
    jsonlPath,
    sessionSummary,
    initMeta,
    sessionStats,
    agentProcess: agentProcessFromTimeline,
    wsStatus,
    isLoading: isTimelineLoading,
    error: timelineError,
    loadMore: loadMoreTimeline,
    hasMore: timelineHasMore,
    retrySession,
    sendResume,
    addPendingUserMessage,
    removePendingUserMessage,
  } = useTimeline({
    sessionName,
    claudeSessionId,
    enabled: !!sessionName,
    resumeCallbacks: {
      onResumeStarted: handleResumeStarted,
      onResumeBlocked: handleResumeBlocked,
      onResumeError: handleResumeError,
    },
    onSync: (state) => {
      const checkedAt = Date.now();
      if (state.agentProcess !== null) {
        useTabStore.getState().setAgentProcess(tabId, state.agentProcess, checkedAt);
      }
      if (!state.agentInstalled) {
        useTabStore.getState().setAgentInstalled(tabId, false);
      }
      useTabStore.getState().setTimelineLoading(tabId, state.isLoading);
    },
    getCliState: () => useTabStore.getState().tabs[tabId]?.cliState,
  });

  const {
    sessions,
    hasMore: sessionListHasMore,
    isLoading: isSessionListLoading,
    isLoadingMore: isSessionListLoadingMore,
    error: sessionListError,
    refetch: refetchSessions,
    loadMore: loadMoreSessions,
  } = useSessionList({
    tmuxSession: sessionName,
    enabled: !!sessionName && agentProcess !== true,
    cwd,
  });

  useEffect(() => {
    if (addPendingMessageRef) addPendingMessageRef.current = addPendingUserMessage;
    if (removePendingMessageRef) removePendingMessageRef.current = removePendingUserMessage;
    return () => {
      if (addPendingMessageRef) addPendingMessageRef.current = undefined;
      if (removePendingMessageRef) removePendingMessageRef.current = undefined;
    };
  }, [addPendingMessageRef, removePendingMessageRef, addPendingUserMessage, removePendingUserMessage]);

  const prevAgentProcessRef = useRef(agentProcess);
  useEffect(() => {
    const prev = prevAgentProcessRef.current;
    prevAgentProcessRef.current = agentProcess;
    if (prev !== true && agentProcess === true && agentProcessFromTimeline !== true) {
      retrySession();
    }
  }, [agentProcess, agentProcessFromTimeline, retrySession]);

  useEffect(() => {
    if (storeCliState !== 'unknown') return;
    const controller = new AbortController();
    fetch('/api/tmux/recover-unknown', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabId }),
      signal: controller.signal,
    }).catch(() => {});
    return () => controller.abort();
  }, [tabId, storeCliState]);

  const startingPromptOptions = useStartingPrompt(view === 'check', sessionName);

  const isHeaderLoading = agentProcess === null || (entries.length === 0 && isTimelineLoading);
  const freshMeta = useSessionMetaCompute(entries, sessionSummary, initMeta, sessionStats, tabClaudeSummary, tabLastUserMessage);

  useEffect(() => {
    if (!isHeaderLoading) {
      useTabStore.getState().setSessionMetaCache(tabId, { meta: freshMeta, sessionId, jsonlPath });
    }
  }, [isHeaderLoading, freshMeta, sessionId, jsonlPath, tabId]);

  const handleSelectSession = useCallback(
    (sid: string) => {
      if (resumingSessionId) return;
      setResumingSessionId(sid);
      sendResume(sid, sessionName);
    },
    [resumingSessionId, sendResume, sessionName],
  );

  if (!agentInstalled) {
    return (
      <div className={cn('flex h-full w-full flex-col items-center justify-center gap-3 text-muted-foreground', className)}>
        <span className="text-sm font-medium">{t('installClaude')}</span>
        <span className="text-xs">{t('installClaudeHint')}</span>
      </div>
    );
  }

  if (trustPrompt && onTrustResponse) {
    return (
      <div className={cn('flex h-full w-full flex-col items-center justify-center animate-delayed-fade-in', className)}>
        <TrustPromptCard
          folderPath={trustPrompt.folderPath}
          agent={trustPrompt.agent}
          onRespond={onTrustResponse}
        />
        <button
          className="mt-3 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={onClose}
        >
          {t('checkTerminal')}
        </button>
      </div>
    );
  }

  if (view === 'check') {
    if (!startingPromptOptions) {
      return (
        <AgentBootProgress
          icon={(
            <ClaudeLogo className="h-8 w-8 text-foreground motion-safe:animate-spin motion-reduce:opacity-70 [animation-duration:1.5s]" />
          )}
          main={(claudeSessionId || sessionId) ? t('claudeBootResuming') : t('claudeBootMain')}
          almostReady={t('claudeBootAlmostReady')}
          subtitle={t('claudeBootSubtitle')}
          className={cn('animate-delayed-fade-in', className)}
        />
      );
    }

    return (
      <div className={cn('flex h-full w-full flex-col items-center justify-center animate-delayed-fade-in', className)}>
        {startingPromptOptions.isBypassPrompt && startingPromptOptions.options.length > 0 ? (
          <BypassPromptCard
            sessionName={sessionName}
            options={startingPromptOptions.options}
            fallback={
              <button
                className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                onClick={onClose}
              >
                {t('checkTerminal')}
              </button>
            }
          />
        ) : (
          <button
            className="mt-3 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={onClose}
          >
            {t('checkTerminal')}
          </button>
        )}
      </div>
    );
  }

  if (view === 'session-list') {
    if (agentProcess === null || (isSessionListLoading && sessions.length === 0)) {
      return (
        <div className={cn('flex h-full w-full flex-col items-center justify-center animate-delayed-fade-in', className)}>
          <Spinner className="h-4 w-4 text-muted-foreground" />
        </div>
      );
    }
    if (sessions.length === 0 && !sessionListError) {
      return (
        <div className={cn('h-full w-full', className)}>
          <SessionEmptyView onClose={onClose} onNewSession={onNewSession} />
        </div>
      );
    }
    return (
      <div className={cn('h-full w-full', className)}>
        <SessionListView
          sessions={sessions}
          isLoading={isSessionListLoading}
          isLoadingMore={isSessionListLoadingMore}
          hasMore={sessionListHasMore}
          error={sessionListError}
          resumingSessionId={resumingSessionId}
          onSelectSession={handleSelectSession}
          onRefresh={refetchSessions}
          onLoadMore={loadMoreSessions}
          onNewSession={onNewSession}
        />
      </div>
    );
  }

  const displayMeta = isHeaderLoading
    ? cachedSessionMeta
    : { meta: freshMeta, sessionId, jsonlPath };

  return (
    <div className={cn('flex min-h-0 w-full flex-1 flex-col', className)}>
      {displayMeta ? (
        <SessionMetaBar
          meta={displayMeta.meta}
          sessionName={sessionName}
          sessionId={displayMeta.sessionId}
          jsonlPath={displayMeta.jsonlPath}
        />
      ) : (
        <SessionMetaBarSkeleton />
      )}
      <div className="min-h-0 flex-1">
        <TimelineView
          entries={entries}
          tasks={tasks}
          sessionId={sessionId}
          sessionName={sessionName}
          tabId={tabId}
          active={active}
          initMeta={initMeta}
          sessionStats={sessionStats}
          cliState={storeCliState}
          compactingSince={compactingSince}
          wsStatus={wsStatus}
          isLoading={isTimelineLoading}
          error={timelineError}
          onRetry={retrySession}
          onLoadMore={loadMoreTimeline}
          hasMore={timelineHasMore}
          scrollToBottomRef={scrollToBottomRef}
        />
      </div>
    </div>
  );
};

export default ClaudeCodePanel;
