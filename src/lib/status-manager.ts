import { WebSocket } from 'ws';
import { getWorkspaces } from '@/lib/workspace-store';
import { readLayoutFile, resolveLayoutFile, collectAllTabs, updateTabCliStatus, updateTabAgentSummary, updateTabAgentState, parseSessionName, setLayoutReconciler } from '@/lib/layout-store';
import { getAllPanesInfo, getListeningPorts, SAFE_SHELLS, getPaneTitle, getSessionCwd, getSessionPanePid } from '@/lib/tmux';
import { getChildPids } from '@/lib/process-utils';
import { getProvider, getProviderByPanelType } from '@/lib/providers/registry';
import { detectAnyActiveSession } from '@/lib/providers/session-scan';
import type { IAgentProvider } from '@/lib/providers/types';
import type { IAgentHookMetaPatch, TAgentWorkStateEvent } from '@/lib/providers/types';
import { deriveAgentCliState } from '@/lib/agent-state-transition';
import { cwdToProjectPath } from '@/lib/session-list';
import { formatTabTitle } from '@/lib/tab-title';
import { createRateLimitsWatcher } from '@/lib/rate-limits-watcher';
import { createLogger } from '@/lib/logger';
import { capturePaneAtWidth } from '@/lib/capture-at-width';
import { isCodexTuiReadyContent } from '@/lib/codex-tui-ready-detector';
import { CODEX_PROVIDER_ID } from '@/lib/providers/codex';
import { findCodexSessionById } from '@/lib/providers/codex/session-detection';
import { cacheCodexRateLimitsFromJsonl } from '@/lib/codex-rate-limits-cache';
import { parsePermissionOptions } from '@/lib/permission-prompt';
import { readEntriesBefore } from '@/lib/session-parser';
import type { IPaneInfo } from '@/lib/tmux';
import type { ITab } from '@/types/terminal';
import type { IAskUserQuestionItem, TCliState } from '@/types/timeline';
import type { ICurrentAction, TTerminalStatus, ITabStatusEntry, IClientTabStatusEntry, IStatusUpdateMessage, IRateLimitsCache, TEventName, ILastEvent } from '@/types/status';
import type { ISessionHistoryEntry } from '@/types/session-history';
import { addSessionHistoryEntry, updateSessionHistoryDismissedAt } from '@/lib/session-history';
import webpush from 'web-push';
import { getSubscriptions, removeSubscription, isAnyDeviceVisible } from '@/lib/push-subscriptions';
import { getVAPIDKeys } from '@/lib/vapid-keys';
import { nanoid } from 'nanoid';
import fs from 'fs/promises';
import { watch, type FSWatcher } from 'fs';

const log = createLogger('status');
const hookLog = createLogger('hooks');

const entryAgentFields = (
  provider: IAgentProvider | null,
  tab: ITab,
  jsonlPath: string | null | undefined,
): { agentProviderId?: string; agentSessionId: string | null; agentSummary: string | null } => ({
  agentProviderId: provider?.id,
  agentSummary: provider?.readSummary(tab) ?? null,
  agentSessionId: provider?.sessionIdFromJsonlPath(jsonlPath ?? null)
    ?? provider?.readSessionId(tab)
    ?? null,
});

// Notification hook의 notification_type 중 권한 요청류만 needs-input으로 전환.
// idle_prompt(응답 후 60s idle 알람), computer_use_*, elicitation_*, auth_success 등은 상태 변경 없이 무시한다.
const INPUT_REQUESTING_NOTIFICATION_TYPES = new Set(['permission_prompt', 'worker_permission_prompt']);

const COMPACT_STALE_MS = 60_000;

const POLL_INTERVAL_SMALL = 30_000;
const POLL_INTERVAL_MEDIUM = 45_000;
const POLL_INTERVAL_LARGE = 60_000;
const TAB_COUNT_MEDIUM = 11;
const TAB_COUNT_LARGE = 21;
const BUSY_STUCK_MS = 10 * 60 * 1000;
const AGENT_LAUNCH_GRACE_MS = 5_000;
const AGENT_GUARDED_STATES: Set<TCliState> = new Set(['busy', 'idle', 'needs-input', 'ready-for-review']);
// tmux set-titles emits "<cmd>|<path>" once a shell takes over the pane.
// An agent CLI normally writes its own title (no pipe), so this regex
// distinguishes "agent gone" from "agent rewrote title" without a process call.
const SHELL_TITLE_RE = /^[^|]+\|[^|]+$/;
const PROCESS_RETRY_COUNT = 3;
const JSONL_WATCH_DEBOUNCE_MS = 100;
const LAUNCH_READY_POLL_DELAYS_MS = [700, 1_500, 3_000, 5_000, 8_000] as const;

const g = globalThis as unknown as { __ptStatusManager?: StatusManager };

const areAskUserQuestionItemsEqual = (
  a: IAskUserQuestionItem[] | null | undefined,
  b: IAskUserQuestionItem[] | null | undefined,
): boolean => {
  if (!a && !b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((item, idx) => {
    const other = b[idx];
    if (!other) return false;
    if (
      item.question !== other.question
      || item.header !== other.header
      || item.multiSelect !== other.multiSelect
      || item.allowCustomAnswer !== other.allowCustomAnswer
      || item.options.length !== other.options.length
    ) {
      return false;
    }
    return item.options.every((option, optIdx) => {
      const otherOption = other.options[optIdx];
      return !!otherOption
        && option.label === otherOption.label
        && option.description === otherOption.description;
    });
  });
};

class StatusManager {
  private tabs = new Map<string, ITabStatusEntry>();
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private currentInterval = 0;
  private clients = new Set<WebSocket>();
  private initialized = false;
  private rateLimitsWatcher: ReturnType<typeof createRateLimitsWatcher> | null = null;
  private lastRateLimits: IRateLimitsCache | null = null;
  private jsonlWatchers = new Map<string, { watcher: FSWatcher; jsonlPath: string; debounceTimer: ReturnType<typeof setTimeout> | null }>();
  private compactStaleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    await this.scanAll();
    this.startPolling();

    this.rateLimitsWatcher = createRateLimitsWatcher((data) => {
      this.lastRateLimits = data;
      this.broadcast({ type: 'rate-limits:update', data });
    });
    this.rateLimitsWatcher.start();
  }

  private async scanAll(): Promise<void> {
    const { workspaces } = await getWorkspaces();
    const panesInfo = await getAllPanesInfo();
    for (const tabId of [...this.jsonlWatchers.keys()]) {
      this.stopJsonlWatch(tabId);
    }
    this.tabs.clear();

    for (const ws of workspaces) {
      const layout = await readLayoutFile(resolveLayoutFile(ws.id));
      if (!layout) continue;

      const tabs = collectAllTabs(layout.root);
      for (const tab of tabs) {
        const paneInfo = panesInfo.get(tab.sessionName);
        const provider = getProviderByPanelType(tab.panelType);
        const detected = await this.readTabMetadata(paneInfo, provider, tab);
        const persisted: TCliState = (tab.cliState as TCliState | undefined) ?? 'idle';
        const cliState: TCliState = persisted === 'busy' ? 'unknown' : persisted;

        const { terminalStatus, listeningPorts } = provider
          ? { terminalStatus: 'idle' as const, listeningPorts: [] as number[] }
          : await this.detectTerminalStatus(paneInfo);
        const currentProcess = paneInfo?.command;
        const paneTitle = paneInfo ? `${paneInfo.command}|${paneInfo.path}` : undefined;
        // lastEvent는 메모리 전용이라 재시작 시 유실. persisted needs-input 복원 시
        // 클라 ack가 seq=0과 매칭할 baseline이 필요하므로 합성한다.
        const syntheticLastEvent: ILastEvent | null = cliState === 'needs-input'
          ? { name: 'notification', at: Date.now(), seq: 0 }
          : null;
        this.tabs.set(tab.id, {
          cliState,
          workspaceId: ws.id,
          tabName: tab.name || (paneTitle ? formatTabTitle(paneTitle, tab.panelType) : ''),
          currentProcess,
          paneTitle,
          tmuxSession: tab.sessionName,
          panelType: tab.panelType,
          terminalStatus,
          listeningPorts,
          ...entryAgentFields(provider, tab, detected.jsonlPath),
          lastUserMessage: tab.lastUserMessage,
          lastAssistantMessage: detected.lastAssistantSnippet,
          currentAction: detected.currentAction,
          readyForReviewAt: cliState === 'ready-for-review' ? Date.now() : null,
          busySince: null,
          dismissedAt: tab.dismissedAt ?? null,
          jsonlPath: detected.jsonlPath,
          lastEvent: syntheticLastEvent,
          eventSeq: 0,
        });
        if ((cliState === 'needs-input' || cliState === 'unknown') && detected.jsonlPath) {
          this.startJsonlWatch(tab.id, detected.jsonlPath);
        }
        if (cliState === 'unknown') {
          this.resolveUnknown(tab.id).catch((err) => log.warn('resolveUnknown failed: %s', err));
        }
      }
    }
  }

  private async resolveUnknown(tabId: string): Promise<void> {
    const entry = this.tabs.get(tabId);
    if (!entry || entry.cliState !== 'unknown') return;

    const provider = getProviderByPanelType(entry.panelType);
    const paneInfo = (await getAllPanesInfo()).get(entry.tmuxSession);
    const childPids = paneInfo?.pid ? await getChildPids(paneInfo.pid) : [];
    const agentRunning = paneInfo?.pid && provider
      ? await provider.isAgentRunning(paneInfo.pid, childPids)
      : false;

    if (!agentRunning) {
      this.applyCliState(tabId, entry, 'idle', { silent: true });
      this.persistToLayout(entry);
      this.broadcastUpdate(tabId, entry);
      return;
    }

    if (provider && entry.jsonlPath) {
      const { idle, stale, lastAssistantSnippet } = await provider.readRuntimeSnapshot(entry.jsonlPath);
      if (idle && !stale && lastAssistantSnippet) {
        this.applyCliState(tabId, entry, 'ready-for-review', { silent: true });
        this.persistToLayout(entry);
        this.broadcastUpdate(tabId, entry);
        return;
      }
    }
  }

  private async readTabMetadata(
    paneInfo: IPaneInfo | undefined,
    provider: IAgentProvider | null,
    tab?: ITab,
  ): Promise<{ lastAssistantSnippet: string | null; currentAction: ICurrentAction | null; jsonlPath: string | null }> {
    const empty = { lastAssistantSnippet: null, currentAction: null, jsonlPath: null };
    if (!paneInfo || !paneInfo.pid || !provider) return empty;

    const childPids = await getChildPids(paneInfo.pid);
    const running = await provider.isAgentRunning(paneInfo.pid, childPids);
    if (!running) return empty;

    if (tab) {
      const persistedJsonlPath = provider.readJsonlPath(tab);
      if (persistedJsonlPath) {
        try {
          await fs.access(persistedJsonlPath);
          const { lastAssistantSnippet, currentAction } = await provider.readRuntimeSnapshot(persistedJsonlPath);
          return { lastAssistantSnippet, currentAction, jsonlPath: persistedJsonlPath };
        } catch { /* fall through */ }
      }

      const persistedSessionId = provider.readSessionId(tab);
      if (persistedSessionId && provider.id === CODEX_PROVIDER_ID) {
        const codexSession = await findCodexSessionById(persistedSessionId);
        if (codexSession?.jsonlPath) {
          const { lastAssistantSnippet, currentAction } = await provider.readRuntimeSnapshot(codexSession.jsonlPath);
          return { lastAssistantSnippet, currentAction, jsonlPath: codexSession.jsonlPath };
        }
      }
    }

    const session = await provider.detectActiveSession(paneInfo.pid, childPids);
    if (session.status !== 'running' || !session.jsonlPath) {
      return { lastAssistantSnippet: null, currentAction: null, jsonlPath: session.jsonlPath ?? null };
    }

    const { lastAssistantSnippet, currentAction } = await provider.readRuntimeSnapshot(session.jsonlPath);
    return { lastAssistantSnippet, currentAction, jsonlPath: session.jsonlPath };
  }

  private async detectTerminalStatus(
    paneInfo?: IPaneInfo,
  ): Promise<{ terminalStatus: TTerminalStatus; listeningPorts: number[] }> {
    if (!paneInfo || !paneInfo.pid) return { terminalStatus: 'idle', listeningPorts: [] };

    const ports = await getListeningPorts(paneInfo.pid);
    if (ports.length > 0) return { terminalStatus: 'server', listeningPorts: ports };

    const isShell = SAFE_SHELLS.has(paneInfo.command);
    return { terminalStatus: isShell ? 'idle' : 'running', listeningPorts: [] };
  }

  private getPollingInterval(): number {
    const count = this.tabs.size;
    if (count >= TAB_COUNT_LARGE) return POLL_INTERVAL_LARGE;
    if (count >= TAB_COUNT_MEDIUM) return POLL_INTERVAL_MEDIUM;
    return POLL_INTERVAL_SMALL;
  }

  async rescan(): Promise<void> {
    await this.scanAll();
  }

  startPolling(): void {
    this.stopPolling();
    this.currentInterval = this.getPollingInterval();
    this.pollingTimer = setInterval(() => {
      this.poll().catch((err) => {
        log.error({ err }, 'Polling error');
      });
    }, this.currentInterval);
  }

  stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
      this.currentInterval = 0;
    }
  }

  async poll(): Promise<void> {
    const { workspaces } = await getWorkspaces();
    const panesInfo = await getAllPanesInfo();
    const knownTabIds = new Set<string>();
    const tabsBeforePoll = new Set(this.tabs.keys());
    const now = Date.now();

    for (const ws of workspaces) {
      const layout = await readLayoutFile(resolveLayoutFile(ws.id));
      if (!layout) continue;

      const tabs = collectAllTabs(layout.root);
      for (const tab of tabs) {
        knownTabIds.add(tab.id);
        const existing = this.tabs.get(tab.id);
        const paneInfo = panesInfo.get(tab.sessionName);
        const provider = getProviderByPanelType(tab.panelType);

        const { terminalStatus, listeningPorts } = provider
          ? { terminalStatus: 'idle' as const, listeningPorts: [] as number[] }
          : await this.detectTerminalStatus(paneInfo);
        const currentProcess = paneInfo?.command;
        const newPaneTitle = paneInfo ? `${paneInfo.command}|${paneInfo.path}` : undefined;

        if (!existing) {
          const persisted: TCliState = (tab.cliState as TCliState | undefined) ?? 'idle';
          const initialState: TCliState = persisted === 'busy' ? 'unknown' : persisted;
          const detected = await this.readTabMetadata(paneInfo, provider, tab);
          // lastEvent는 메모리 전용이라 재시작 시 유실. persisted needs-input을 복원할 때는
          // 클라이언트 ack가 seq=0과 매칭할 baseline이 필요하므로 합성한다.
          const syntheticLastEvent: ILastEvent | null = initialState === 'needs-input'
            ? { name: 'notification', at: Date.now(), seq: 0 }
            : null;
          const entry: ITabStatusEntry = {
            cliState: initialState,
            workspaceId: ws.id,
            tabName: tab.name || (newPaneTitle ? formatTabTitle(newPaneTitle, tab.panelType) : ''),
            currentProcess,
            paneTitle: newPaneTitle,
            tmuxSession: tab.sessionName,
            panelType: tab.panelType,
            terminalStatus,
            listeningPorts,
            ...entryAgentFields(provider, tab, detected.jsonlPath),
            lastUserMessage: tab.lastUserMessage,
            lastAssistantMessage: detected.lastAssistantSnippet,
            currentAction: detected.currentAction,
            jsonlPath: detected.jsonlPath,
            lastEvent: syntheticLastEvent,
            eventSeq: 0,
          };
          this.tabs.set(tab.id, entry);
          this.persistToLayout(entry);
          this.broadcastUpdate(tab.id, entry);
          if (initialState === 'unknown') {
            this.resolveUnknown(tab.id).catch((err) => log.warn('resolveUnknown failed: %s', err));
          }
          continue;
        }

        const processChanged = existing.currentProcess !== currentProcess;
        const messageChanged = existing.lastUserMessage !== tab.lastUserMessage;
        const panelTypeChanged = existing.panelType !== tab.panelType;
        const refreshed = await this.readTabMetadata(paneInfo, provider, tab);
        existing.tabName = tab.name || (newPaneTitle ? formatTabTitle(newPaneTitle, tab.panelType) : '');
        existing.currentProcess = currentProcess;
        existing.paneTitle = newPaneTitle;
        existing.workspaceId = ws.id;
        existing.panelType = tab.panelType;
        existing.agentProviderId = provider?.id;
        existing.agentSessionId = provider?.sessionIdFromJsonlPath(refreshed.jsonlPath)
          ?? provider?.readSessionId(tab) ?? null;
        existing.jsonlPath = refreshed.jsonlPath ?? existing.jsonlPath;
        existing.lastUserMessage = tab.lastUserMessage;

        if (processChanged) {
          existing.processRetries = PROCESS_RETRY_COUNT;
        }
        const processRetryNeeded = !processChanged && (existing.processRetries ?? 0) > 0;
        if (processRetryNeeded) {
          existing.processRetries = existing.processRetries! - 1;
        }

        const prevPorts = existing.listeningPorts;
        const portsChanged = prevPorts?.length !== listeningPorts.length
          || listeningPorts.some((p, i) => prevPorts![i] !== p);
        const terminalChanged = existing.terminalStatus !== terminalStatus || portsChanged;
        if (terminalChanged) {
          existing.terminalStatus = terminalStatus;
          existing.listeningPorts = listeningPorts;
        }

        let summaryChanged = false;
        const tabSummary = provider ? provider.readSummary(tab) : null;
        if (existing.cliState === 'busy' || existing.cliState === 'needs-input') {
          const paneTitle = await getPaneTitle(tab.sessionName);
          const liveSummary = provider?.parsePaneTitle(paneTitle) ?? null;
          const nextSummary = liveSummary ?? tabSummary;
          if (nextSummary !== existing.agentSummary) {
            existing.agentSummary = nextSummary;
            summaryChanged = true;
            if (liveSummary && provider) {
              updateTabAgentSummary(tab.sessionName, provider, liveSummary).catch(() => {});
            }
          }
        } else {
          if (existing.agentSummary !== tabSummary) {
            existing.agentSummary = tabSummary;
            summaryChanged = true;
          }
        }

        let agentRunningCache: boolean | null = null;
        const checkAgentRunning = async (): Promise<boolean> => {
          if (agentRunningCache !== null) return agentRunningCache;
          if (!paneInfo?.pid || !provider) {
            agentRunningCache = false;
            return false;
          }
          const childPids = await getChildPids(paneInfo.pid);
          agentRunningCache = await provider.isAgentRunning(paneInfo.pid, childPids);
          return agentRunningCache;
        };

        if (existing.cliState === 'busy' && existing.lastEvent
            && now - existing.lastEvent.at > BUSY_STUCK_MS) {
          if (!(await checkAgentRunning())) {
            log.info({ tabId: tab.id }, 'busy stuck — agent process gone, forcing idle');
            this.applyCliState(tab.id, existing, 'idle', { silent: true });
            this.persistToLayout(existing);
            this.broadcastUpdate(tab.id, existing);
            continue;
          }
        }

        if (provider && AGENT_GUARDED_STATES.has(existing.cliState)) {
          const stamp = existing.lastResumeOrStartedAt;
          const inGrace = stamp !== undefined && now - stamp < AGENT_LAUNCH_GRACE_MS;
          if (!inGrace) {
            const title = existing.paneTitle ?? '';
            const titleShellStyle = !!title && SHELL_TITLE_RE.test(title);
            if ((!title || titleShellStyle) && !(await checkAgentRunning())) {
              log.info({ tabId: tab.id, prevState: existing.cliState }, 'agent process gone — transitioning to inactive');
              this.applyCliState(tab.id, existing, 'inactive', { silent: true });
              this.persistToLayout(existing);
              this.broadcastUpdate(tab.id, existing);
              continue;
            }
          }
        }

        if (existing.cliState === 'inactive' && existing.panelType === 'codex-cli' && provider) {
          if (await this.checkCodexTuiReady(existing, checkAgentRunning)) {
            hookLog.debug({ tabId: tab.id }, 'codex tui ready — synthetic session-start');
            this.updateTabFromHook(existing.tmuxSession, 'session-start');
            continue;
          }
        }

        if (terminalChanged || processChanged || processRetryNeeded || messageChanged || panelTypeChanged || summaryChanged) {
          this.broadcastUpdate(tab.id, existing);
        }
      }
    }

    for (const tabId of tabsBeforePoll) {
      if (!knownTabIds.has(tabId) && this.tabs.has(tabId)) {
        this.stopJsonlWatch(tabId);
        this.tabs.delete(tabId);
        this.broadcastRemove(tabId);
      }
    }

    const newInterval = this.getPollingInterval();
    if (this.pollingTimer && newInterval !== this.currentInterval) {
      this.startPolling();
    }
  }

  getAllForClient(): Record<string, IClientTabStatusEntry> {
    const result: Record<string, IClientTabStatusEntry> = {};
    for (const [tabId, entry] of this.tabs) {
      result[tabId] = {
        cliState: entry.cliState,
        workspaceId: entry.workspaceId,
        tabName: entry.tabName,
        currentProcess: entry.currentProcess,
        paneTitle: entry.paneTitle,
        panelType: entry.panelType,
        terminalStatus: entry.terminalStatus,
        listeningPorts: entry.listeningPorts,
        agentProviderId: entry.agentProviderId,
        agentSummary: entry.agentSummary,
        lastUserMessage: entry.lastUserMessage,
        lastAssistantMessage: entry.lastAssistantMessage,
        currentAction: entry.currentAction,
        readyForReviewAt: entry.readyForReviewAt,
        busySince: entry.busySince,
        dismissedAt: entry.dismissedAt,
        agentSessionId: entry.agentSessionId,
        compactingSince: entry.compactingSince,
        permissionRequest: entry.permissionRequest,
        pendingQuestions: entry.pendingQuestions,
        lastEvent: entry.lastEvent,
        eventSeq: entry.eventSeq,
      };
    }
    return result;
  }

  private applyCliState(tabId: string, entry: ITabStatusEntry, newState: TCliState, opts: { silent?: boolean } = {}): void {
    const prevState = entry.cliState;
    if (prevState === newState) return;
    const prevBusySince = entry.busySince;
    entry.cliState = newState;
    entry.readyForReviewAt = newState === 'ready-for-review' ? Date.now() : null;
    entry.busySince = newState === 'busy' ? Date.now() : null;
    if (newState === 'busy') entry.dismissedAt = null;
    if (prevState === 'needs-input' && newState !== 'needs-input') {
      if (entry.permissionRequest) entry.permissionRequest = null;
      if (entry.pendingQuestions) entry.pendingQuestions = null;
    }

    if (newState === 'ready-for-review' && entry.jsonlPath) {
      const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      delay(500).then(() => this.saveSessionHistory(tabId, entry, prevBusySince, false)).catch((err) => {
        log.warn('Failed to save session history: %s', err);
      });
    }

    if (newState === 'ready-for-review' && !opts.silent) {
      this.sendWebPush(tabId, entry, 'review').catch((err) => {
        log.warn('Web push failed: %s', err);
      });
    }

    if (newState === 'needs-input' && !opts.silent) {
      this.sendWebPush(tabId, entry, 'needs-input').catch((err) => {
        log.warn('Web push failed: %s', err);
      });
    }

    const shouldWatch = (newState === 'busy' || newState === 'needs-input') && entry.jsonlPath;
    const keepForFinalRead = newState === 'ready-for-review' && this.jsonlWatchers.has(tabId);
    if (shouldWatch && !this.jsonlWatchers.has(tabId)) {
      this.startJsonlWatch(tabId, entry.jsonlPath!);
    } else if (!shouldWatch && !keepForFinalRead && this.jsonlWatchers.has(tabId)) {
      this.stopJsonlWatch(tabId);
    }
  }

  private async saveSessionHistory(tabId: string, entry: ITabStatusEntry, prevBusySince: number | null | undefined, cancelled: boolean): Promise<void> {
    if (!entry.lastUserMessage) return;

    const provider = entry.agentProviderId ? getProvider(entry.agentProviderId) : getProviderByPanelType(entry.panelType);
    const stats = entry.jsonlPath && provider
      ? await provider.readSessionHistoryStats(entry.jsonlPath)
      : null;
    const { workspaces } = await getWorkspaces();
    const ws = workspaces.find((w) => w.id === entry.workspaceId);
    const now = Date.now();
    const startedAt = stats?.firstUserTs ?? prevBusySince ?? now;
    const completedAt = cancelled ? now : (stats?.lastAssistantTs ?? now);
    const duration = cancelled
      ? completedAt - startedAt
      : (stats?.turnDurationMs ?? (completedAt - startedAt));

    const providerId = entry.agentProviderId === 'codex' ? 'codex' : 'claude';
    const historyEntry: ISessionHistoryEntry = {
      id: nanoid(),
      workspaceId: entry.workspaceId,
      workspaceName: ws?.name ?? entry.workspaceId,
      workspaceDir: ws?.directories[0] ?? null,
      tabId,
      providerId,
      agentSessionId: entry.agentSessionId ?? null,
      prompt: stats?.lastUserText ?? entry.lastUserMessage,
      result: stats?.lastAssistantText ?? null,
      startedAt,
      completedAt,
      duration,
      dismissedAt: completedAt,
      toolUsage: stats?.toolUsage ?? {},
      touchedFiles: stats?.touchedFiles ?? [],
      ...(cancelled ? { cancelled: true } : {}),
    };

    await addSessionHistoryEntry(historyEntry);
    this.broadcast({ type: 'session-history:update', entry: historyEntry });
  }

  dismissTab(tabId: string, exclude?: WebSocket): void {
    const entry = this.tabs.get(tabId);
    if (!entry || entry.cliState !== 'ready-for-review') return;

    const dismissedAt = Date.now();
    this.applyCliState(tabId, entry, 'idle', { silent: true });
    entry.dismissedAt = dismissedAt;
    this.persistToLayout(entry);
    this.broadcastUpdate(tabId, entry, exclude);

    updateSessionHistoryDismissedAt(tabId, dismissedAt).then((updated) => {
      if (updated) this.broadcast({ type: 'session-history:update', entry: updated });
    }).catch((err) => {
      log.warn('Failed to update session history dismissedAt: %s', err);
    });
  }

  ackNotificationInput(tabId: string, seq: number): void {
    const entry = this.tabs.get(tabId);
    if (!entry) return;
    if (entry.cliState !== 'needs-input') return;
    if (entry.lastEvent?.name !== 'notification' || entry.lastEvent.seq !== seq) return;

    hookLog.debug({ tabId, seq }, 'ack: needs-input→busy');
    this.applyCliState(tabId, entry, 'busy');
    this.persistToLayout(entry);
    this.broadcastUpdate(tabId, entry);
  }

  // Codex의 SessionStart hook은 첫 사용자 메시지 후에야 발사된다(turn.rs:299).
  // 그 전엔 cliState가 'inactive'에 머물러 WebInputBar가 비활성화되므로
  // dead state. 3-layer 신호로 composer가 입력 받을 준비됐다고 확신될 때
  // 합성 session-start를 트리거해 idle로 진입시킨다.
  private async checkCodexTuiReady(
    entry: ITabStatusEntry,
    checkAgentRunning: () => Promise<boolean>,
  ): Promise<boolean> {
    if (!(await checkAgentRunning())) return false;

    const content = await capturePaneAtWidth(entry.tmuxSession, 80, 24).catch((err) => {
      log.warn('codex tui ready capture failed: %s', err);
      return null;
    });
    if (!content) return false;
    return isCodexTuiReadyContent(content);
  }

  async recoverUnknownIfPending(tabId: string): Promise<{ recovered: boolean; reason?: string }> {
    const entry = this.tabs.get(tabId);
    if (!entry) return { recovered: false, reason: 'no-entry' };
    if (entry.cliState !== 'unknown') return { recovered: false, reason: 'not-unknown' };

    const content = await capturePaneAtWidth(entry.tmuxSession, 120, 50).catch((err) => {
      log.warn('recoverUnknownIfPending capture failed: %s', err);
      return null;
    });
    if (!content) return { recovered: false, reason: 'capture-failed' };

    const { options } = parsePermissionOptions(content);
    if (options.length === 0) return { recovered: false, reason: 'no-options' };

    const now = Date.now();
    const seq = (entry.eventSeq ?? 0) + 1;
    entry.eventSeq = seq;
    entry.lastEvent = { name: 'notification', at: now, seq };

    hookLog.debug({ tabId, seq, options: options.length }, 'recover unknown→needs-input from pane capture');
    this.applyCliState(tabId, entry, 'needs-input', { silent: true });
    this.persistToLayout(entry);
    this.broadcastUpdate(tabId, entry);
    return { recovered: true };
  }

  private findTabIdBySession(tmuxSession: string): string | undefined {
    for (const [tabId, entry] of this.tabs) {
      if (entry.tmuxSession === tmuxSession) return tabId;
    }
    return undefined;
  }

  updateTabFromHook(tmuxSession: string, event: string, notificationType?: string): void {
    const tabId = this.findTabIdBySession(tmuxSession);
    if (!tabId) {
      hookLog.debug({ tmuxSession, event, notificationType }, 'no tabId for session');
      return;
    }
    const entry = this.tabs.get(tabId);
    if (!entry) {
      hookLog.debug({ tabId, event, notificationType }, 'no entry for tab');
      return;
    }

    if (event === 'pre-compact' || event === 'post-compact') {
      hookLog.debug({ tabId, event }, 'compact hook');
      this.setCompacting(tabId, entry, event === 'pre-compact' ? Date.now() : null);
      return;
    }

    if (event !== 'session-start' && event !== 'prompt-submit' && event !== 'notification' && event !== 'stop' && event !== 'interrupt') {
      hookLog.debug({ tabId, event, notificationType }, 'unknown event, ignoring');
      return;
    }
    const eventName = event as TEventName;

    if (eventName === 'notification' && notificationType && !INPUT_REQUESTING_NOTIFICATION_TYPES.has(notificationType)) {
      hookLog.debug({ tabId, event: eventName, notificationType }, 'non-input notification, skipping state transition');
      return;
    }

    const now = Date.now();
    const seq = (entry.eventSeq ?? 0) + 1;
    entry.eventSeq = seq;
    entry.lastEvent = { name: eventName, at: now, seq };
    if (eventName === 'session-start') entry.lastResumeOrStartedAt = now;
    this.broadcast({ type: 'status:hook-event', tabId, event: entry.lastEvent });

    const prevState = entry.cliState;
    const newState = deriveAgentCliState(entry.lastEvent, prevState);

    hookLog.debug(
      { tabId, event: eventName, notificationType, seq, prevState, newState, transition: prevState !== newState },
      `processed ${eventName}${notificationType ? `(${notificationType})` : ''} ${prevState}→${newState}`,
    );

    if (prevState !== newState) {
      this.applyCliState(tabId, entry, newState);
      this.persistToLayout(entry);
      this.broadcastUpdate(tabId, entry);
    }

    if ((newState === 'busy' || newState === 'needs-input') && !entry.jsonlPath) {
      this.resolveAndWatchJsonl(tabId, tmuxSession).catch(() => {});
    }

    if (eventName === 'stop' && entry.jsonlPath) {
      const refreshSnippet = (force = false) => {
        const provider = getProviderByPanelType(entry.panelType);
        if (!provider) return;
        provider.readRuntimeSnapshot(entry.jsonlPath!, { force }).then(({ currentAction, lastAssistantSnippet, reset }) => {
          let updated = false;
          if (reset) {
            if (entry.currentAction !== null) { entry.currentAction = null; updated = true; }
            if (entry.lastAssistantMessage !== null) { entry.lastAssistantMessage = null; updated = true; }
          } else {
            if (currentAction !== null && currentAction.summary !== entry.currentAction?.summary) {
              entry.currentAction = currentAction;
              updated = true;
            }
            if (lastAssistantSnippet !== null && entry.lastAssistantMessage !== lastAssistantSnippet) {
              entry.lastAssistantMessage = lastAssistantSnippet;
              updated = true;
            }
          }
          if (updated) this.broadcastUpdate(tabId, entry);
        }).catch(() => {});
      };
      refreshSnippet();
      setTimeout(() => {
        refreshSnippet(true);
      }, 500);
    }
  }

  handleProviderEvent(providerId: string, tmuxSession: string, event: TAgentWorkStateEvent): boolean {
    const tabId = this.findTabIdBySession(tmuxSession);
    if (!tabId) {
      hookLog.debug({ providerId, tmuxSession, event: event.kind }, 'no tabId for provider event');
      return false;
    }
    const entry = this.tabs.get(tabId);
    if (!entry) {
      hookLog.debug({ providerId, tabId, event: event.kind }, 'no entry for provider event tab');
      return false;
    }
    const expectedProvider = getProviderByPanelType(entry.panelType);
    if (expectedProvider && expectedProvider.id !== providerId) {
      hookLog.debug(
        { providerId, expectedProviderId: expectedProvider.id, tabId, event: event.kind },
        'provider event panel mismatch',
      );
      return false;
    }
    this.handleTabWorkStateEvent(tabId, event);
    return true;
  }

  applyAgentHookMeta(
    providerId: string,
    tmuxSession: string,
    meta: IAgentHookMetaPatch,
  ): { tabId: string; cliState: TCliState } | null {
    const tabId = this.findTabIdBySession(tmuxSession);
    if (!tabId) return null;
    const entry = this.tabs.get(tabId);
    if (!entry) return null;
    const expectedProvider = getProviderByPanelType(entry.panelType);
    if (expectedProvider && expectedProvider.id !== providerId) {
      hookLog.debug(
        { providerId, expectedProviderId: expectedProvider.id, tabId },
        'provider hook meta panel mismatch',
      );
      return null;
    }

    let changed = false;

    if (entry.agentProviderId !== providerId) {
      entry.agentProviderId = providerId;
      changed = true;
    }
    if (meta.sessionId !== undefined && entry.agentSessionId !== meta.sessionId) {
      entry.agentSessionId = meta.sessionId;
      changed = true;
    }
    if (meta.jsonlPath !== undefined && entry.jsonlPath !== meta.jsonlPath) {
      entry.jsonlPath = meta.jsonlPath;
      changed = true;
    }
    if (meta.clearMessages) {
      if (entry.agentSummary !== null) { entry.agentSummary = null; changed = true; }
      if (entry.lastUserMessage !== null) { entry.lastUserMessage = null; changed = true; }
      if (entry.lastAssistantMessage !== null) { entry.lastAssistantMessage = null; changed = true; }
    }
    if (meta.lastUserMessage !== undefined && entry.lastUserMessage !== meta.lastUserMessage) {
      entry.lastUserMessage = meta.lastUserMessage;
      changed = true;
    }
    if (meta.agentSummary !== undefined && entry.agentSummary !== meta.agentSummary) {
      entry.agentSummary = meta.agentSummary;
      changed = true;
    }
    if (meta.permissionRequest !== undefined && entry.permissionRequest !== meta.permissionRequest) {
      entry.permissionRequest = meta.permissionRequest;
      changed = true;
    }
    if (meta.askUserQuestionItems !== undefined) {
      const nextQuestions = meta.askUserQuestionItems;
      if (!areAskUserQuestionItemsEqual(entry.pendingQuestions, nextQuestions)) {
        entry.pendingQuestions = nextQuestions;
        changed = true;
      }
    }

    if (changed) {
      const provider = expectedProvider ?? getProvider(providerId);
      if (provider) {
        updateTabAgentState(entry.tmuxSession, provider, {
          ...(meta.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
          ...(meta.jsonlPath !== undefined ? { jsonlPath: meta.jsonlPath } : {}),
          ...(meta.agentSummary !== undefined || meta.clearMessages
            ? { summary: meta.clearMessages ? null : meta.agentSummary ?? null }
            : {}),
          ...(meta.lastUserMessage !== undefined || meta.clearMessages
            ? { lastUserMessage: meta.clearMessages ? null : meta.lastUserMessage ?? null }
            : {}),
        }).catch(() => {});
      }
      this.persistToLayout(entry);
      this.broadcastUpdate(tabId, entry);
    }

    return { tabId, cliState: entry.cliState };
  }

  async applyProviderStatuslineMeta(
    providerId: string,
    tmuxSession: string,
    meta: { sessionId?: string | null; jsonlPath?: string | null },
  ): Promise<void> {
    const patch: IAgentHookMetaPatch = {};
    if (meta.sessionId !== undefined) patch.sessionId = meta.sessionId;
    if (meta.jsonlPath !== undefined) patch.jsonlPath = meta.jsonlPath;

    const applied = Object.keys(patch).length > 0
      ? this.applyAgentHookMeta(providerId, tmuxSession, patch)
      : null;

    const tabId = applied?.tabId ?? this.findTabIdBySession(tmuxSession);
    if (!tabId) return;
    const entry = this.tabs.get(tabId);
    if (!entry) return;

    const jsonlPath = meta.jsonlPath ?? entry.jsonlPath ?? null;
    if (!jsonlPath) return;
    if (providerId !== 'claude') return;

    await this.syncPendingAskUserQuestion(providerId, entry, jsonlPath);
  }

  private async readLatestAskUserQuestionState(
    jsonlPath: string,
  ): Promise<{ found: boolean; questions: IAskUserQuestionItem[] | null }> {
    const stat = await fs.stat(jsonlPath);
    const { entries } = await readEntriesBefore(jsonlPath, stat.size, 200);
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry.type === 'ask-user-question') {
        return {
          found: true,
          questions: entry.status === 'pending' ? entry.questions : null,
        };
      }
    }
    return { found: false, questions: null };
  }

  private async syncPendingAskUserQuestion(
    providerId: string,
    entry: ITabStatusEntry,
    jsonlPath: string,
  ): Promise<void> {
    let latest: { found: boolean; questions: IAskUserQuestionItem[] | null };
    try {
      latest = await this.readLatestAskUserQuestionState(jsonlPath);
    } catch (err) {
      hookLog.debug({ err, jsonlPath }, 'failed to read AskUserQuestion state from statusLine JSONL');
      return;
    }
    if (!latest.found) return;

    const tmuxSession = entry.tmuxSession;
    if (latest.questions && latest.questions.length > 0) {
      const alreadyNeedsInput = entry.cliState === 'needs-input'
        && areAskUserQuestionItemsEqual(entry.pendingQuestions, latest.questions);
      this.applyAgentHookMeta(providerId, tmuxSession, { askUserQuestionItems: latest.questions });
      if (!alreadyNeedsInput) {
        this.handleProviderEvent(providerId, tmuxSession, {
          kind: 'notification',
          notificationType: 'permission_prompt',
        });
      }
      return;
    }

    if (entry.pendingQuestions) {
      this.applyAgentHookMeta(providerId, tmuxSession, { askUserQuestionItems: null });
    }
    if (entry.cliState === 'needs-input') {
      this.handleProviderEvent(providerId, tmuxSession, { kind: 'prompt-submit' });
    }
  }

  private setCompacting(tabId: string, entry: ITabStatusEntry, since: number | null): void {
    const existingTimer = this.compactStaleTimers.get(tabId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.compactStaleTimers.delete(tabId);
    }

    if ((entry.compactingSince ?? null) === since) return;
    entry.compactingSince = since;
    this.broadcastUpdate(tabId, entry);

    if (since !== null) {
      const timer = setTimeout(() => {
        this.compactStaleTimers.delete(tabId);
        const e = this.tabs.get(tabId);
        if (!e || e.compactingSince !== since) return;
        e.compactingSince = null;
        hookLog.debug({ tabId }, 'compact stale, auto-cleared');
        this.broadcastUpdate(tabId, e);
      }, COMPACT_STALE_MS);
      this.compactStaleTimers.set(tabId, timer);
    }
  }

  removeTab(tabId: string): void {
    const entry = this.tabs.get(tabId);
    if (entry && (entry.cliState === 'busy' || entry.cliState === 'needs-input') && entry.lastUserMessage) {
      this.saveSessionHistory(tabId, entry, entry.busySince, true).catch((err) => {
        log.warn('Failed to save cancelled session history: %s', err);
      });
    }
    this.stopJsonlWatch(tabId);
    const compactTimer = this.compactStaleTimers.get(tabId);
    if (compactTimer) {
      clearTimeout(compactTimer);
      this.compactStaleTimers.delete(tabId);
    }
    this.tabs.delete(tabId);
    this.broadcastRemove(tabId);
  }

  reconcileWorkspaceTabs(wsId: string, validTabIds: readonly string[]): void {
    const valid = new Set(validTabIds);
    for (const [tabId, entry] of this.tabs) {
      if (entry.workspaceId === wsId && !valid.has(tabId)) {
        this.removeTab(tabId);
      }
    }
  }

  removeWorkspaceTabs(wsId: string): void {
    for (const [tabId, entry] of this.tabs) {
      if (entry.workspaceId === wsId) {
        this.removeTab(tabId);
      }
    }
  }

  registerTab(tabId: string, entry: ITabStatusEntry): void {
    this.tabs.set(tabId, entry);
    this.broadcastUpdate(tabId, entry);
  }

  private handleTabWorkStateEvent(tabId: string, event: TAgentWorkStateEvent): void {
    const entry = this.tabs.get(tabId);
    if (!entry) return;
    switch (event.kind) {
      case 'session-start':
      case 'prompt-submit':
      case 'stop':
      case 'interrupt':
      case 'pre-compact':
      case 'post-compact':
        this.updateTabFromHook(entry.tmuxSession, event.kind);
        break;
      case 'notification':
        this.updateTabFromHook(entry.tmuxSession, 'notification', event.notificationType);
        break;
      case 'summary-update':
        if (entry.agentSummary !== event.summary) {
          entry.agentSummary = event.summary;
          this.broadcastUpdate(tabId, entry);
        }
        break;
      case 'last-user-message':
        if (entry.lastUserMessage !== event.message) {
          entry.lastUserMessage = event.message;
          this.broadcastUpdate(tabId, entry);
        }
        break;
    }
  }

  markAgentLaunch(tabId: string, options?: { resetAgentSession?: boolean }): void {
    const entry = this.tabs.get(tabId);
    if (!entry) return;
    entry.lastResumeOrStartedAt = Date.now();
    if (options?.resetAgentSession) {
      entry.agentSessionId = null;
      entry.jsonlPath = null;
      entry.agentSummary = null;
      entry.lastUserMessage = null;
      entry.lastAssistantMessage = null;
      entry.currentAction = null;
      entry.permissionRequest = null;
      entry.pendingQuestions = null;
      const existingWatcher = this.jsonlWatchers.get(tabId);
      if (existingWatcher) {
        existingWatcher.watcher.close();
        if (existingWatcher.debounceTimer) clearTimeout(existingWatcher.debounceTimer);
        this.jsonlWatchers.delete(tabId);
      }
      this.persistToLayout(entry);
      const provider = getProviderByPanelType(entry.panelType);
      if (provider) {
        updateTabAgentState(entry.tmuxSession, provider, {
          sessionId: null,
          jsonlPath: null,
          summary: null,
          lastUserMessage: null,
        }).catch(() => {});
      }
      this.broadcastUpdate(tabId, entry);
    }
    for (const delay of LAUNCH_READY_POLL_DELAYS_MS) {
      setTimeout(() => {
        this.poll().catch((err) => {
          log.error({ err, tabId }, 'Launch readiness poll error');
        });
      }, delay);
    }
  }

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    if (this.lastRateLimits && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'rate-limits:update', data: this.lastRateLimits }));
    }
  }

  removeClient(ws: WebSocket): void {
    this.clients.delete(ws);
  }

  private persistToLayout(entry: ITabStatusEntry): void {
    updateTabCliStatus(entry.tmuxSession, entry.cliState, entry.dismissedAt).catch(() => {});
  }

  private broadcastUpdate(tabId: string, entry: ITabStatusEntry, exclude?: WebSocket): void {
    const msg: IStatusUpdateMessage = {
      type: 'status:update',
      tabId,
      cliState: entry.cliState,
      workspaceId: entry.workspaceId,
      tabName: entry.tabName,
      currentProcess: entry.currentProcess,
      paneTitle: entry.paneTitle,
      panelType: entry.panelType,
      terminalStatus: entry.terminalStatus,
      listeningPorts: entry.listeningPorts,
      agentProviderId: entry.agentProviderId,
      agentSummary: entry.agentSummary,
      lastUserMessage: entry.lastUserMessage,
      lastAssistantMessage: entry.lastAssistantMessage,
      currentAction: entry.currentAction,
      readyForReviewAt: entry.readyForReviewAt,
      busySince: entry.busySince,
      dismissedAt: entry.dismissedAt,
      agentSessionId: entry.agentSessionId,
      compactingSince: entry.compactingSince,
      permissionRequest: entry.permissionRequest,
      pendingQuestions: entry.pendingQuestions,
      lastEvent: entry.lastEvent,
      eventSeq: entry.eventSeq,
    };
    this.broadcast(msg, exclude);
  }

  private broadcastRemove(tabId: string): void {
    const msg: IStatusUpdateMessage = {
      type: 'status:update',
      tabId,
      cliState: null,
      workspaceId: '',
      tabName: '',
    };
    this.broadcast(msg);
  }

  private static readonly BACKPRESSURE_LIMIT = 1024 * 1024;

  broadcast(event: object, exclude?: WebSocket): void {
    const msg = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws !== exclude && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < StatusManager.BACKPRESSURE_LIMIT) {
        ws.send(msg);
      }
    }
  }

  private async resolveAndWatchJsonl(tabId: string, tmuxSession: string): Promise<void> {
    const entry = this.tabs.get(tabId);
    if (!entry || entry.jsonlPath) return;

    let jsonlPath: string | null = null;

    const parsed = parseSessionName(tmuxSession);
    if (parsed) {
      const layout = await readLayoutFile(resolveLayoutFile(parsed.wsId));
      if (layout) {
        const tab = collectAllTabs(layout.root).find((t) => t.sessionName === tmuxSession);
        const tabProvider = getProviderByPanelType(tab?.panelType);
        const tabSessionId = tab && tabProvider ? tabProvider.readSessionId(tab) : null;
        if (tab && tabProvider && tabSessionId) {
          if (tabProvider.id === CODEX_PROVIDER_ID) {
            jsonlPath = (await findCodexSessionById(tabSessionId))?.jsonlPath ?? null;
          } else {
            const cwd = await getSessionCwd(tmuxSession);
            if (cwd) {
              const candidate = `${cwdToProjectPath(cwd)}/${tabSessionId}.jsonl`;
              try {
                await fs.access(candidate);
                jsonlPath = candidate;
              } catch { /* noop */ }
            }
          }
        }

        if (tab?.lastUserMessage && entry.lastUserMessage !== tab.lastUserMessage) {
          entry.lastUserMessage = tab.lastUserMessage;
          this.broadcastUpdate(tabId, entry);
        }
      }
    }

    if (!jsonlPath) {
      const panePid = await getSessionPanePid(tmuxSession);
      if (panePid) {
        const { info } = await detectAnyActiveSession(panePid);
        jsonlPath = info.jsonlPath;
      }
    }

    if (!jsonlPath) return;

    entry.jsonlPath = jsonlPath;
    const provider = getProviderByPanelType(entry.panelType);
    if (provider) {
      entry.agentProviderId = provider.id;
      entry.agentSessionId = provider.sessionIdFromJsonlPath(jsonlPath) ?? entry.agentSessionId;
    }

    if ((entry.cliState === 'busy' || entry.cliState === 'needs-input') && !this.jsonlWatchers.has(tabId)) {
      this.startJsonlWatch(tabId, jsonlPath);
    }
  }

  private startJsonlWatch(tabId: string, jsonlPath: string): void {
    const existing = this.jsonlWatchers.get(tabId);
    if (existing?.jsonlPath === jsonlPath) return;
    if (existing) this.stopJsonlWatch(tabId);

    log.debug('startJsonlWatch tabId=%s path=%s', tabId, jsonlPath);
    try {
      const watcher = watch(jsonlPath, () => {
        const w = this.jsonlWatchers.get(tabId);
        if (!w) return;
        if (w.debounceTimer) clearTimeout(w.debounceTimer);
        w.debounceTimer = setTimeout(() => {
          this.onJsonlFileChange(tabId, jsonlPath).catch(() => {});
        }, JSONL_WATCH_DEBOUNCE_MS);
      });
      watcher.on('error', () => {
        this.stopJsonlWatch(tabId);
      });
      this.jsonlWatchers.set(tabId, { watcher, jsonlPath, debounceTimer: null });
    } catch {
      // file may not exist yet
    }
  }

  private stopJsonlWatch(tabId: string): void {
    const w = this.jsonlWatchers.get(tabId);
    if (!w) return;
    log.debug('stopJsonlWatch tabId=%s', tabId);
    if (w.debounceTimer) clearTimeout(w.debounceTimer);
    try { w.watcher.close(); } catch { /* noop */ }
    this.jsonlWatchers.delete(tabId);
  }

  private async onJsonlFileChange(tabId: string, jsonlPath: string): Promise<void> {
    const entry = this.tabs.get(tabId);
    if (!entry) {
      this.stopJsonlWatch(tabId);
      return;
    }
    const isActive = entry.cliState === 'busy' || entry.cliState === 'needs-input' || entry.cliState === 'unknown';
    if (!isActive && entry.cliState !== 'ready-for-review') {
      this.stopJsonlWatch(tabId);
      return;
    }

    const provider = getProviderByPanelType(entry.panelType);
    if (!provider) return;
    const { currentAction, lastAssistantSnippet, reset, interrupted, lastEntryTs } = await provider.readRuntimeSnapshot(jsonlPath);
    if (entry.agentProviderId === CODEX_PROVIDER_ID || entry.panelType === 'codex-cli') {
      cacheCodexRateLimitsFromJsonl(jsonlPath).catch(() => {});
    }
    const providerId = provider.id;
    if (providerId === 'claude') {
      await this.syncPendingAskUserQuestion(providerId, entry, jsonlPath);
    }

    if (
      interrupted
      && entry.cliState === 'busy'
      && lastEntryTs !== null
      && lastEntryTs > (entry.lastInterruptTs ?? 0)
      && lastEntryTs > (entry.lastEvent?.at ?? 0)
    ) {
      entry.lastInterruptTs = lastEntryTs;
      hookLog.debug({ tabId, lastEntryTs }, 'synthetic interrupt from JSONL');
      this.updateTabFromHook(entry.tmuxSession, 'interrupt');
    }

    let changed = false;

    if (reset) {
      if (entry.currentAction !== null) { entry.currentAction = null; changed = true; }
      if (entry.lastAssistantMessage !== null) { entry.lastAssistantMessage = null; changed = true; }
    } else {
      if (currentAction !== null && currentAction.summary !== entry.currentAction?.summary) {
        entry.currentAction = currentAction;
        changed = true;
      }
      if (lastAssistantSnippet !== null && entry.lastAssistantMessage !== lastAssistantSnippet) {
        entry.lastAssistantMessage = lastAssistantSnippet;
        changed = true;
      }
    }

    if (changed) {
      this.broadcastUpdate(tabId, entry);
    }
  }

  shutdown(): void {
    this.stopPolling();
    this.rateLimitsWatcher?.stop();
    for (const tabId of [...this.jsonlWatchers.keys()]) {
      this.stopJsonlWatch(tabId);
    }
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1001, 'Server shutting down');
      }
    }
    this.clients.clear();
  }

  notifyLastUserMessage(sessionName: string, message: string): void {
    const parsed = parseSessionName(sessionName);
    if (!parsed) return;
    const entry = this.tabs.get(parsed.tabId);
    if (!entry || entry.lastUserMessage === message) return;
    entry.lastUserMessage = message;
    this.broadcastUpdate(parsed.tabId, entry);
  }

  private async sendWebPush(tabId: string, entry: ITabStatusEntry, pushType: 'review' | 'needs-input'): Promise<void> {
    const subs = await getSubscriptions();
    if (subs.length === 0) return;

    const keys = await getVAPIDKeys();
    webpush.setVapidDetails('mailto:noreply@purplemux.app', keys.publicKey, keys.privateKey);

    const title = pushType === 'needs-input' ? 'Input Required' : 'Task Complete';
    const body = entry.lastUserMessage?.slice(0, 100) || entry.tabName || tabId;
    const ws = (await getWorkspaces()).workspaces.find((w) => w.id === entry.workspaceId);
    const providerId = entry.agentProviderId === 'codex' ? 'codex' : 'claude';
    const payload = JSON.stringify({
      title,
      body,
      tabId,
      workspaceId: entry.workspaceId,
      providerId,
      // Field name kept `claudeSessionId` for SW back-compat: existing service workers
      // (public/sw.js) read this key and a brief stale-SW window during upgrade would
      // break notifications if renamed.
      claudeSessionId: entry.agentSessionId ?? null,
      workspaceName: ws?.name ?? '',
      workspaceDir: ws?.directories[0] ?? null,
    });

    if (isAnyDeviceVisible()) return;
    for (const sub of subs) {
      try {
        await webpush.sendNotification(sub, payload);
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 410 || status === 404) {
          await removeSubscription(sub.endpoint);
        }
        log.warn('Web push send error: %s', status);
      }
    }
  }
}

export const getStatusManager = (): StatusManager => {
  if (!g.__ptStatusManager) {
    const manager = new StatusManager();
    g.__ptStatusManager = manager;
    setLayoutReconciler({
      reconcileWorkspaceTabs: (wsId, validTabIds) => manager.reconcileWorkspaceTabs(wsId, validTabIds),
      removeWorkspaceTabs: (wsId) => manager.removeWorkspaceTabs(wsId),
    });
  }
  return g.__ptStatusManager;
};
