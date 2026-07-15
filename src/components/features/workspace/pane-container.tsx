import { useState, useRef, useCallback, useEffect, useMemo, memo } from 'react';
import { useTranslations } from 'next-intl';
import { Group, Panel, Separator, type GroupImperativeHandle } from 'react-resizable-panels';
import { ChevronDown, ChevronUp, Plus, TerminalSquare } from 'lucide-react';
import Spinner from '@/components/ui/spinner';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { ITab, TPanelType } from '@/types/terminal';
import { findPane } from '@/lib/layout-tree';
import useTerminal from '@/hooks/use-terminal';
import useTerminalWebSocket from '@/hooks/use-terminal-websocket';
import useTabMetadataStore from '@/hooks/use-tab-metadata-store';
import { useLayoutStore } from '@/hooks/use-layout';
import useConfigStore, { type TGitAskProvider } from '@/hooks/use-config-store';
import useIsMobileDevice from '@/hooks/use-is-mobile-device';
import { resolveLineHeight } from '@/lib/terminal-line-height';
import { toCtrlChar } from '@/lib/terminal-keys';
import TerminalKeyBar from '@/components/features/workspace/terminal-key-bar';
import { useShallow } from 'zustand/react/shallow';
import { buildClaudeLaunchCommand } from '@/lib/providers/claude/client';
import { fetchCodexLaunchCommand } from '@/lib/providers/codex/client';
import { sendCodexQuitCommand } from '@/lib/agent-terminal-commands';
import TerminalContainer from '@/components/features/workspace/terminal-container';
import ClaudeCodePanel from '@/components/features/workspace/claude-code-panel';
import CodexPanel from '@/components/features/workspace/codex-panel';
import AgentSessionsPanel from '@/components/features/workspace/agent-sessions-panel';
import WebInputBar from '@/components/features/workspace/web-input-bar';
import QuickPromptBar from '@/components/features/workspace/quick-prompt-bar';
import ConnectionStatus from '@/components/features/workspace/connection-status';
import WebBrowserPanel from '@/components/features/workspace/web-browser-panel';
import DiffPanel from '@/components/features/workspace/diff-panel';
import PaneDisconnectedOverlay from '@/components/features/workspace/pane-disconnected-overlay';
import PaneAgentModePrompt from '@/components/features/workspace/pane-agent-mode-prompt';
import PanePathInputOverlay from '@/components/features/workspace/pane-path-input-overlay';
import useTrustPromptDetector from '@/hooks/use-trust-prompt-detector';
import useCodexUpdatePromptDetector from '@/hooks/use-codex-update-prompt-detector';
import useQuickPrompts from '@/hooks/use-quick-prompts';
import useFileDrop from '@/hooks/use-file-drop';
import { useAgentInstallCheck } from '@/hooks/use-agent-install-check';
import PaneTabBar from '@/components/features/workspace/pane-tab-bar';
import { formatTabTitle, parseCurrentCommand, isShellProcess } from '@/lib/tab-title';
import { isAppShortcut, isClearShortcut, isFocusInputShortcut, isShiftEnter } from '@/lib/keyboard-shortcuts';
import useTerminalTheme from '@/hooks/use-terminal-theme';
import useTabStore, { getInitialTabStateFromLayoutTab, selectSessionView, isCliIdle } from '@/hooks/use-tab-store';
import { dismissTab as dismissStatusTab } from '@/hooks/use-agent-status';
import type { IAgentSessionEntry } from '@/hooks/use-agent-sessions';
import {
  applyAgentCheckResult,
  isAgentPanelType,
  type IAgentCheckResponse,
  type TAgentPanelType,
} from '@/lib/agent-check';


interface ITermActions {
  write: (data: Uint8Array) => void;
  reset: () => void;
  fit: () => { cols: number; rows: number };
  focus: () => void;
  getBufferText: () => string;
}

interface IWsActions {
  sendStdin: (data: string) => void;
  sendResize: (cols: number, rows: number) => void;
}

interface IAgentModePrompt {
  tabId: string;
  providerId: string;
  displayName: string;
  panelType: TAgentPanelType;
  sessionId: string | null;
  resumable: boolean;
}

const NOOP_TERM_ACTIONS: ITermActions = {
  write: () => {},
  reset: () => {},
  fit: () => ({ cols: 80, rows: 24 }),
  focus: () => {},
  getBufferText: () => '',
};

const NOOP_WS_ACTIONS: IWsActions = {
  sendStdin: () => {},
  sendResize: () => {},
};

interface IPaneContainerProps {
  paneId: string;
  paneNumber: number;
}

const TERMINAL_FONT_SIZES: Record<string, { normal: number; claudeCode: number }> = {
  normal: { normal: 12, claudeCode: 10 },
  large: { normal: 14, claudeCode: 12 },
  'x-large': { normal: 16, claudeCode: 14 },
};
const MIN_COLLAPSED_AGENT_ROWS = 40;

const EMPTY_TABS: ITab[] = [];

const PaneContainer = memo(({ paneId, paneNumber }: IPaneContainerProps) => {
  const t = useTranslations('terminal');

  const pane = useLayoutStore((s) => (s.layout ? findPane(s.layout.root, paneId) : null));
  const tabs = pane?.tabs ?? EMPTY_TABS;
  const activeTabId = pane?.activeTabId ?? null;
  const isFocused = useLayoutStore((s) => s.layout?.activePaneId === paneId);
  const paneCount = useLayoutStore((s) => s.paneCount);
  const isSplitting = useLayoutStore((s) => s.isSplitting);

  const switchTabInPane = useLayoutStore((s) => s.switchTabInPane);
  const createTabInPane = useLayoutStore((s) => s.createTabInPane);
  const deleteTabInPane = useLayoutStore((s) => s.deleteTabInPane);
  const closePane = useLayoutStore((s) => s.closePane);
  const focusPane = useLayoutStore((s) => s.focusPane);
  const moveTab = useLayoutStore((s) => s.moveTab);
  const renameTabInPane = useLayoutStore((s) => s.renameTabInPane);
  const reorderTabsInPane = useLayoutStore((s) => s.reorderTabsInPane);
  const updateTabPanelType = useLayoutStore((s) => s.updateTabPanelType);
  const updateTabTerminalLayout = useLayoutStore((s) => s.updateTabTerminalLayout);
  const diffSettings = useLayoutStore((s) => s.layout?.diffSettings);
  const updateDiffSettings = useLayoutStore((s) => s.updateDiffSettings);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activePanelType: TPanelType = activeTab?.panelType ?? 'terminal';
  const isClaudeCode = activePanelType === 'claude-code';
  const isCodex = activePanelType === 'codex-cli';
  const isAgentSessionList = activePanelType === 'agent-sessions';
  const isAgentPanel = isClaudeCode || isCodex;
  const isWebBrowser = activePanelType === 'web-browser';
  const isDiff = activePanelType === 'diff';
  const { ensureAgentInstalled, installDialogs } = useAgentInstallCheck();

  const { theme: terminalTheme } = useTerminalTheme();
  const configFontSize = useConfigStore((s) => s.fontSize);
  const configLineHeight = useConfigStore((s) => s.lineHeight);
  const configLineHeightCustom = useConfigStore((s) => s.lineHeightCustom);
  const keyBarMode = useConfigStore((s) => s.terminalKeyBar);
  const isTouchDevice = useIsMobileDevice();
  const claudeShowTerminal = useConfigStore((s) => s.claudeShowTerminal);

  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [shiftArmed, setShiftArmed] = useState(false);
  const ctrlArmedRef = useRef(false);
  const shiftArmedRef = useRef(false);
  useEffect(() => {
    ctrlArmedRef.current = ctrlArmed;
  }, [ctrlArmed]);
  useEffect(() => {
    shiftArmedRef.current = shiftArmed;
  }, [shiftArmed]);

  const applyArmedModifier = useCallback((data: string): string => {
    if (data.length !== 1) return data;
    if (ctrlArmedRef.current) {
      setCtrlArmed(false);
      return toCtrlChar(data) ?? data;
    }
    if (shiftArmedRef.current) {
      setShiftArmed(false);
      return data.toUpperCase();
    }
    return data;
  }, []);
  const effectiveTerminalCollapsed = activeTab?.terminalCollapsed ?? !claudeShowTerminal;
  const [isTerminalCollapsed, setIsTerminalCollapsed] = useState(effectiveTerminalCollapsed);
  const [hasEverConnected, setHasEverConnected] = useState(false);
  const [sessionSwitching, setSessionSwitching] = useState(false);
  const sessionSwitchTimerRef = useRef(0);
  const [isCreating, setIsCreating] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [isPanelTransitioning, setIsPanelTransitioning] = useState(false);

  const tabIds = useMemo(() => tabs.map((t) => t.id), [tabs]);
  const tabTitles = useTabMetadataStore(
    useShallow((state) => {
      const result: Record<string, string> = {};
      for (const tab of tabs) {
        if (tab.panelType === 'agent-sessions') continue;
        const title = state.metadata[tab.id]?.title;
        if (title) result[tab.id] = title;
      }
      return result;
    }),
  );

  const tabProcesses = useTabStore(
    useShallow((state) => {
      const result: Record<string, string> = {};
      for (const id of tabIds) {
        const p = state.tabs[id]?.currentProcess;
        if (p) result[id] = p;
      }
      return result;
    }),
  );

  const activeTabCwd = useTabMetadataStore(
    (state) => (activeTabId ? state.metadata[activeTabId]?.cwd : undefined),
  );

  const layoutWsId = useLayoutStore((state) => state.workspaceId);

  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => {
      cancelAnimationFrame(id);
    };
  }, []);
  const termActionsRef = useRef<ITermActions>(NOOP_TERM_ACTIONS);
  const wsActionsRef = useRef<IWsActions>(NOOP_WS_ACTIONS);
  const lastVisibleTerminalSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const connectedSessionRef = useRef<string | null>(null);
  const prevConnectedTabIdRef = useRef<string | null>(null);
  const closingTabIdRef = useRef<string | null>(null);

  const tabsRef = useRef(tabs);
  const activeTabIdRef = useRef(activeTabId);
  const paneCountRef = useRef(paneCount);
  const isFocusedRef = useRef(isFocused);

  useEffect(() => {
    tabsRef.current = tabs;
    activeTabIdRef.current = activeTabId;
    paneCountRef.current = paneCount;
    isFocusedRef.current = isFocused;
  });

  const fetchAndUpdateCwd = useCallback(async () => {
    const tabId = activeTabIdRef.current;
    const tab = tabId ? tabsRef.current.find((t) => t.id === tabId) : null;
    if (!tab) return;
    try {
      const res = await fetch(`/api/layout/cwd?session=${tab.sessionName}`);
      if (!res.ok) return;
      const { cwd, lastCommand } = await res.json();
      if (cwd) useTabMetadataStore.getState().setCwd(tab.id, cwd);
      useTabMetadataStore.getState().setLastCommand(tab.id, lastCommand ?? null);
    } catch {
      /* ignore */
    }
  }, []);

  const clearRef = useRef<() => void>(() => {});
  const focusInputRef = useRef<(() => void) | undefined>(undefined);
  const setInputValueRef = useRef<((v: string) => void) | undefined>(undefined);
  const pendingAgentInputRef = useRef<{ text: string; provider: TGitAskProvider } | null>(null);
  const codexRelaunchRef = useRef<() => void | Promise<void>>(() => {});
  const clickedTerminalRef = useRef(false);
  const pointerDownPosRef = useRef<{ x: number; y: number } | null>(null);
  const pendingFocusRef = useRef<(() => void) | null>(null);
  const wasDragRef = useRef(false);

  const scrollToBottomRef = useRef<(() => void) | undefined>(undefined);
  const addPendingMessageRef = useRef<((text: string, options?: { autoHide?: boolean; attachmentPlaceholder?: boolean }) => string) | undefined>(undefined);
  const removePendingMessageRef = useRef<((id: string) => void) | undefined>(undefined);
  const attachFilesRef = useRef<((files: File[]) => Promise<boolean> | void) | undefined>(undefined);
  const pendingRestartRef = useRef<string | null>(null);
  const lastTitleRef = useRef('');

  const claudeCliState = useTabStore((s) => activeTabId ? s.tabs[activeTabId]?.cliState ?? 'inactive' : 'inactive');
  const agentProcess = useTabStore((s) => activeTabId ? s.tabs[activeTabId]?.agentProcess ?? null : null);
  const claudeSessionId = useTabStore((s) => activeTabId ? s.tabs[activeTabId]?.agentSessionId ?? null : null);
  const sessionView = useTabStore((s) => activeTabId ? selectSessionView(s.tabs, activeTabId) : 'session-list');
  const agentInputVisible = sessionView === 'timeline';

  const deferredFocusInput = useCallback((fn: () => void) => {
    if (wasDragRef.current) return;
    if (pointerDownPosRef.current) {
      pendingFocusRef.current = fn;
    } else {
      fn();
    }
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    pointerDownPosRef.current = { x: e.clientX, y: e.clientY };
    pendingFocusRef.current = null;
    wasDragRef.current = false;
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const pos = pointerDownPosRef.current;
    pointerDownPosRef.current = null;
    const isDrag = !!pos && (e.clientX - pos.x) ** 2 + (e.clientY - pos.y) ** 2 >= 25;
    if (isDrag) {
      wasDragRef.current = true;
      requestAnimationFrame(() => { wasDragRef.current = false; });
    }
    if (pendingFocusRef.current && !isDrag) {
      pendingFocusRef.current();
    }
    pendingFocusRef.current = null;
  }, []);

  const { prompts: quickPrompts } = useQuickPrompts();

  const agentModeShownTabsRef = useRef<Set<string>>(new Set());
  const [agentModePrompt, setAgentModePrompt] = useState<IAgentModePrompt | null>(null);

  const handleAgentCheckResult = useCallback((tabId: string, data: IAgentCheckResponse) => {
    if (data.running !== true || !isAgentPanelType(data.providerPanelType)) {
      setAgentModePrompt((prev) => (prev?.tabId === tabId ? null : prev));
      return;
    }

    const providerId = typeof data.providerId === 'string' && data.providerId
      ? data.providerId
      : data.providerPanelType;
    const promptKey = `${tabId}:${providerId}`;
    if (agentModeShownTabsRef.current.has(promptKey)) return;
    agentModeShownTabsRef.current.add(promptKey);

    const displayName = typeof data.providerDisplayName === 'string' && data.providerDisplayName
      ? data.providerDisplayName
      : providerId;
    setAgentModePrompt({
      tabId,
      providerId,
      displayName,
      panelType: data.providerPanelType,
      sessionId: typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : null,
      resumable: data.resumable === true,
    });
  }, []);

  const { trustPrompt, onTerminalData: onTrustData, onTrustResponse } = useTrustPromptDetector({
    enabled: (isClaudeCode || isCodex) && claudeCliState === 'inactive',
    getBufferText: () => termActionsRef.current.getBufferText(),
    sendStdin: (data) => wsActionsRef.current.sendStdin(data),
  });
  const {
    updatePrompt: codexUpdatePrompt,
    onTerminalData: onCodexUpdateData,
    onRespond: onCodexUpdateResponse,
  } = useCodexUpdatePromptDetector({
    enabled: isCodex && claudeCliState === 'inactive',
    scopeKey: activeTabId,
    getBufferText: () => termActionsRef.current.getBufferText(),
    sendStdin: (data) => wsActionsRef.current.sendStdin(data),
    onUpdated: () => { void codexRelaunchRef.current(); },
  });

  useEffect(() => {
    if (!activeTabId || !isAgentPanel) return;
    if (isFocused && isCliIdle(claudeCliState)) {
      dismissStatusTab(activeTabId);
    }
  }, [activeTabId, claudeCliState, isAgentPanel, isFocused]);

  useEffect(() => {
    if (activeTabId && isFocused) {
      dismissStatusTab(activeTabId);
    }
  }, [activeTabId, isFocused]);

  const handleScrollToBottom = useCallback(() => {
    if (claudeCliState !== 'idle') return;
    scrollToBottomRef.current?.();
  }, [claudeCliState]);

  const handleOptimisticSend = useCallback((text: string) => {
    addPendingMessageRef.current?.(text);
  }, []);

  const handleAddPendingMessage = useCallback(
    (text: string, options?: { autoHide?: boolean; attachmentPlaceholder?: boolean }) =>
      addPendingMessageRef.current?.(text, options) ?? '',
    [],
  );

  const handleRemovePendingMessage = useCallback((id: string) => {
    removePendingMessageRef.current?.(id);
  }, []);

  const handleTimelineDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleTimelineDrop = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    if (!attachFilesRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    void attachFilesRef.current(Array.from(e.dataTransfer.files));
  }, []);

  const handleSelectQuickPrompt = useCallback((prompt: string) => {
    setInputValueRef.current?.(prompt);
    focusInputRef.current?.();
  }, []);


  const handleCustomKeyEvent = useCallback((event: KeyboardEvent): boolean => {
    if (isAppShortcut(event)) {
      event.preventDefault();
      if (isClearShortcut(event)) clearRef.current();
      if (isFocusInputShortcut(event)) focusInputRef.current?.();
      return false;
    }
    if (isShiftEnter(event)) {
      event.preventDefault();
      wsActionsRef.current.sendStdin('\n');
      return false;
    }
    return true;
  }, []);

  const normalizeTerminalSize = useCallback((cols: number, rows: number, collapsed = isTerminalCollapsed): { cols: number; rows: number } => {
    if (!isAgentPanel) return { cols, rows };
    if (!collapsed) {
      lastVisibleTerminalSizeRef.current = { cols, rows };
      return { cols, rows };
    }
    return {
      cols,
      rows: Math.max(rows, lastVisibleTerminalSizeRef.current?.rows ?? 0, MIN_COLLAPSED_AGENT_ROWS),
    };
  }, [isAgentPanel, isTerminalCollapsed]);

  const sendEffectiveResize = useCallback((cols: number, rows: number, collapsed?: boolean) => {
    const size = normalizeTerminalSize(cols, rows, collapsed);
    wsActionsRef.current.sendResize(size.cols, size.rows);
  }, [normalizeTerminalSize]);

  const { terminalRef, write, clear, reset, fit, focus, isReady, getBufferText } = useTerminal({
    theme: terminalTheme.colors,
    fontSize: (TERMINAL_FONT_SIZES[configFontSize] ?? TERMINAL_FONT_SIZES.normal)[isAgentPanel ? 'claudeCode' : 'normal'],
    lineHeight: resolveLineHeight(configLineHeight, configLineHeightCustom),
    onInput: (data) => {
      wsActionsRef.current.sendStdin(applyArmedModifier(data));
    },
    onResize: sendEffectiveResize,
    onTitleChange: (title) => {
      const tabId = activeTabIdRef.current;
      if (!tabId) return;
      const activeTab = tabsRef.current.find((t) => t.id === tabId);
      if (!activeTab) return;
      if (activeTab?.panelType === 'web-browser' || activeTab?.panelType === 'agent-sessions') return;
      if (title === lastTitleRef.current) return;
      lastTitleRef.current = title;

      const formatted = formatTabTitle(title, activeTab?.panelType);
      const process = parseCurrentCommand(title);
      useTabMetadataStore.getState().setTitle(tabId, formatted);
      useTabStore.getState().setCurrentProcess(tabId, process);
      if (isShellProcess(title) && pendingRestartRef.current) {
        const cmd = pendingRestartRef.current;
        pendingRestartRef.current = null;
        wsActionsRef.current.sendStdin(`${cmd}\r`);
      }
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (tab) {
        const prevCheckedAt = useTabStore.getState().tabs[tabId]?.agentProcessCheckedAt ?? 0;
        fetch(`/api/check-agent?session=${tab.sessionName}`)
          .then((res) => res.json())
          .then((data: IAgentCheckResponse) => {
            if (activeTab?.panelType === 'terminal') handleAgentCheckResult(tabId, data);
            const { running } = data.running === true && isAgentPanelType(data.providerPanelType)
              ? { running: true }
              : { running: false };
            const current = useTabStore.getState().tabs[tabId];
            if (current && current.agentProcessCheckedAt !== prevCheckedAt) {
              if (current.agentProcess !== running) {
                setTimeout(() => {
                  fetch(`/api/check-agent?session=${tab.sessionName}`)
                    .then((r) => r.json())
                    .then((retryData: IAgentCheckResponse) => {
                      if (activeTab?.panelType === 'terminal') handleAgentCheckResult(tabId, retryData);
                      applyAgentCheckResult(tabId, retryData);
                    })
                    .catch(() => {});
                }, 500);
              }
              return;
            }
            applyAgentCheckResult(tabId, data);
          })
          .catch(() => {});
      }
      fetchAndUpdateCwd();
    },
    customKeyEventHandler: handleCustomKeyEvent,
  });

  useEffect(() => {
    clearRef.current = clear;
  });

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (isFocusInputShortcut(e) && isFocused) {
        e.preventDefault();
        focusInputRef.current?.();
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [isFocused]);

  const handleSessionEnded = useCallback(async () => {
    if (closingTabIdRef.current) return;

    const currentTabs = tabsRef.current;
    const currentActiveTabId = activeTabIdRef.current;
    const currentPaneCount = paneCountRef.current;

    if (!currentActiveTabId) return;

    const isLastTab = currentTabs.length === 1;
    if (isLastTab && currentPaneCount > 1) {
      closePane(paneId);
      return;
    }

    const sorted = [...currentTabs].sort((a, b) => a.order - b.order);
    const idx = sorted.findIndex((t) => t.id === currentActiveTabId);
    const adjacent = sorted[idx + 1] || sorted[idx - 1];
    if (adjacent) {
      switchTabInPane(paneId, adjacent.id);
    }

    closingTabIdRef.current = currentActiveTabId;
    try {
      await deleteTabInPane(paneId, currentActiveTabId);
    } finally {
      closingTabIdRef.current = null;
    }
  }, [paneId, switchTabInPane, deleteTabInPane, closePane]);

  const {
    status,
    retryCount,
    disconnectReason,
    connect,
    reconnect,
    sendStdin,
    sendWebStdin,
    sendResize,
  } = useTerminalWebSocket({
    onData: (data) => {
      termActionsRef.current.write(data);
      onTrustData();
      onCodexUpdateData();
    },
    onConnected: () => {
      setHasEverConnected(true);
      prevConnectedTabIdRef.current = activeTabIdRef.current;
      const tabId = activeTabIdRef.current;
      if (tabId) useTabStore.getState().setTerminalConnected(tabId, true);
      const { cols, rows } = termActionsRef.current.fit();
      sendEffectiveResize(cols, rows);
      if (isFocusedRef.current) {
        termActionsRef.current.focus();
      }
      fetchAndUpdateCwd();
      clearTimeout(sessionSwitchTimerRef.current);
      sessionSwitchTimerRef.current = window.setTimeout(() => setSessionSwitching(false), 50);
    },
    onSessionEnded: handleSessionEnded,
  });

  useEffect(() => {
    termActionsRef.current = { write, reset, fit, focus, getBufferText };
    wsActionsRef.current = { sendStdin, sendResize };
  });

  useEffect(() => {
    if (!isReady) {
      connectedSessionRef.current = null;
    }
  }, [isReady]);

  useEffect(() => {
    if (!isReady || !activeTabId) return;
    const tab = tabs.find((t) => t.id === activeTabId);
    if (!tab) return;
    if (tab.panelType === 'web-browser') {
      lastTitleRef.current = '';
      return;
    }
    if (connectedSessionRef.current === tab.sessionName) return;

    if (connectedSessionRef.current !== null) {
      setSessionSwitching(true);
      reset();
      lastTitleRef.current = '';
    }

    const tabStore = useTabStore.getState();
    const existingTabState = tabStore.tabs[activeTabId];

    // 탭 전환 시 터미널 연결 상태만 리셋, 상태 WS가 관리하는 값은 보존
    tabStore.initTab(activeTabId, {
      terminalConnected: false,
      panelType: tab.panelType,
      ...(!existingTabState ? getInitialTabStateFromLayoutTab(tab) : {}),
    });

    connectedSessionRef.current = tab.sessionName;
    const { cols, rows } = fit();
    const isAgentTab = tab.panelType === 'claude-code' || tab.panelType === 'codex-cli';
    const initialSize = normalizeTerminalSize(
      cols,
      rows,
      isAgentTab ? (tab.terminalCollapsed ?? !claudeShowTerminal) : false,
    );
    connect(tab.sessionName, initialSize.cols, initialSize.rows);
  }, [isReady, activeTabId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    useTabStore.getState().setTerminalConnected(tabId, status === 'connected');
  }, [status]);

  useEffect(() => {
    if (
      status === 'disconnected' &&
      hasEverConnected &&
      prevConnectedTabIdRef.current &&
      prevConnectedTabIdRef.current !== activeTabId &&
      tabs.some((t) => t.id === prevConnectedTabIdRef.current)
    ) {
      connectedSessionRef.current = null;
      switchTabInPane(paneId, prevConnectedTabIdRef.current);
    }
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isReady || status !== 'connected') return;
    const timer = setTimeout(() => {
      const { cols, rows } = fit();
      sendEffectiveResize(cols, rows);
    }, 150);
    return () => clearTimeout(timer);
  }, [paneCount]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isReady || status !== 'connected') return;
    const timer = setTimeout(() => {
      const { cols, rows } = fit();
      sendEffectiveResize(cols, rows);
    }, 300);
    return () => clearTimeout(timer);
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isFocused && isReady && status === 'connected') {
      const { cols, rows } = fit();
      sendEffectiveResize(cols, rows);
      const targetTerminal = clickedTerminalRef.current;
      clickedTerminalRef.current = false;
      if (targetTerminal || !isAgentPanel || !agentInputVisible) {
        focus();
      } else {
        deferredFocusInput(() => focusInputRef.current?.());
      }
    }
  }, [isFocused]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSwitchTab = useCallback(
    (tabId: string) => {
      if (tabId === activeTabId) return;
      dismissStatusTab(tabId);
      switchTabInPane(paneId, tabId);
    },
    [paneId, activeTabId, switchTabInPane],
  );

  const handleCreateTab = useCallback(async (panelType?: TPanelType, options?: { command?: string; resumeSessionId?: string }) => {
    setIsCreating(true);
    const newTab = await createTabInPane(paneId, panelType, options?.command, options?.resumeSessionId);
    if (newTab) {
      useTabStore.getState().initTab(newTab.id, { panelType, workspaceId: layoutWsId ?? '' });
      if (options?.command || options?.resumeSessionId) {
        useTabStore.getState().setSessionView(newTab.id, 'check');
      }
      const currentTabId = activeTabIdRef.current;
      const currentTitle = currentTabId
        ? useTabMetadataStore.getState().metadata[currentTabId]?.title
        : null;
      if (currentTitle && panelType !== 'web-browser' && panelType !== 'agent-sessions') {
        useTabMetadataStore.getState().setTitle(newTab.id, currentTitle);
      }
    }
    setIsCreating(false);
  }, [paneId, createTabInPane, layoutWsId]);

  const handleDeleteTab = useCallback(
    async (tabId: string) => {
      if (closingTabIdRef.current) return;
      const isLastTab = tabs.length === 1;
      if (isLastTab && paneCount > 1) {
        closePane(paneId);
        return;
      }
      closingTabIdRef.current = tabId;
      try {
        await deleteTabInPane(paneId, tabId);
      } finally {
        closingTabIdRef.current = null;
      }
    },
    [paneId, tabs, paneCount, deleteTabInPane, closePane],
  );

  const handleRestartTab = useCallback(
    async (tabId: string, command?: string) => {
      const ok = await useLayoutStore.getState().restartTabInPane(paneId, tabId, command);
      if (ok) reconnect();
    },
    [paneId, reconnect],
  );

  const autoRestartedTabsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (status !== 'disconnected' || disconnectReason !== 'session-not-found') return;
    if (!activeTabId || !activeTab) return;
    const effectivePanelType = activeTab.panelType ?? 'terminal';
    if (effectivePanelType !== 'terminal') return;
    if (activeTab.lastCommand) return;
    if (autoRestartedTabsRef.current.has(activeTabId)) return;
    autoRestartedTabsRef.current.add(activeTabId);
    handleRestartTab(activeTabId);
  }, [status, disconnectReason, activeTabId, activeTab, handleRestartTab]);

  const handleRenameTab = useCallback(
    (tabId: string, name: string) => {
      renameTabInPane(paneId, tabId, name);
    },
    [paneId, renameTabInPane],
  );

  const handleReorderTabs = useCallback(
    (tabIds: string[]) => {
      reorderTabsInPane(paneId, tabIds);
    },
    [paneId, reorderTabsInPane],
  );

  const handleMoveTab = useCallback(
    (tabId: string, fromPaneId: string, toIndex: number) => {
      moveTab(tabId, fromPaneId, paneId, toIndex);
    },
    [paneId, moveTab],
  );

  const handleFocusPane = useCallback(() => {
    focusPane(paneId);
  }, [paneId, focusPane]);

  const handleSwitchPanelType = useCallback((next: TPanelType) => {
    if (!activeTabId) return;
    setIsPanelTransitioning(true);
    updateTabPanelType(paneId, activeTabId, next);
  }, [paneId, activeTabId, updateTabPanelType]);

  const handleSendToAgent = useCallback(async (text: string, provider: TGitAskProvider) => {
    if (!await ensureAgentInstalled(provider)) return;
    pendingAgentInputRef.current = { text, provider };
    handleSwitchPanelType(provider === 'codex' ? 'codex-cli' : 'claude-code');
  }, [ensureAgentInstalled, handleSwitchPanelType]);

  useEffect(() => {
    const handleSidePanelAgentRequest = (event: Event) => {
      const detail = (event as CustomEvent<{
        paneId?: string;
        text?: string;
        provider?: TGitAskProvider;
      }>).detail;
      if (detail?.paneId !== paneId || !detail.text || !detail.provider) return;
      void handleSendToAgent(detail.text, detail.provider);
    };

    window.addEventListener('purplemux-send-to-agent', handleSidePanelAgentRequest);
    return () => window.removeEventListener('purplemux-send-to-agent', handleSidePanelAgentRequest);
  }, [paneId, handleSendToAgent]);

  useEffect(() => {
    const pending = pendingAgentInputRef.current;
    if (!pending) return;
    const targetPanelType: TPanelType = pending.provider === 'codex' ? 'codex-cli' : 'claude-code';
    if (activePanelType !== targetPanelType) return;
    pendingAgentInputRef.current = null;
    const timer = window.setTimeout(() => {
      setInputValueRef.current?.(pending.text);
      focusInputRef.current?.();
    }, 100);
    return () => window.clearTimeout(timer);
  }, [activePanelType]);

  const handleWebUrlChange = useCallback((url: string) => {
    if (!activeTabId || !layoutWsId) return;
    fetch(`/api/layout/pane/${paneId}/tabs/${activeTabId}?workspace=${layoutWsId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webUrl: url }),
    }).catch(() => {});
  }, [activeTabId, paneId, layoutWsId]);

  useEffect(() => {
    if (!activeTabId || agentProcess !== true || activePanelType !== 'terminal') {
      setAgentModePrompt(null);
      return;
    }
    if (agentModePrompt?.tabId !== activeTabId) return;
  }, [activeTabId, agentProcess, activePanelType, agentModePrompt]);

  useEffect(() => {
    if (!activeTabId || agentProcess !== true || activePanelType !== 'terminal') return;
    if (agentModePrompt?.tabId === activeTabId) return;
    const sessionName = activeTab?.sessionName;
    if (!sessionName) return;

    let cancelled = false;
    fetch(`/api/check-agent?session=${sessionName}`)
      .then((res) => res.json())
      .then((data: IAgentCheckResponse) => {
        if (!cancelled) handleAgentCheckResult(activeTabId, data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeTabId, activePanelType, activeTab?.sessionName, agentProcess, agentModePrompt?.tabId, handleAgentCheckResult]);

  const {
    showPathInput,
    droppedFileHint,
    handleDragOver: handleTerminalDragOver,
    handleDrop: handleTerminalDrop,
    handlePathInputSubmit,
    handlePathInputDismiss,
  } = useFileDrop({
    sendStdin: (data) => wsActionsRef.current.sendStdin(data),
    focus,
    wsId: layoutWsId ?? undefined,
    tabId: activeTabId ?? undefined,
  });

  const buildClaudeCommand = useCallback((sessionId: string | null): string =>
    buildClaudeLaunchCommand({
      workspaceId: layoutWsId,
      dangerouslySkipPermissions: useConfigStore.getState().dangerouslySkipPermissions,
      resumeSessionId: sessionId,
    }), [layoutWsId]);

  const handleNewClaudeSession = useCallback(async () => {
    if (status !== 'connected' || !activeTabId) return;
    if (!await ensureAgentInstalled('claude')) return;
    useTabStore.getState().setSessionView(activeTabId, 'check');
    sendStdin(`${buildClaudeCommand(null)}\r`);
  }, [status, sendStdin, activeTabId, buildClaudeCommand, ensureAgentInstalled]);

  const handleRestartClaudeSession = useCallback(async () => {
    if (status !== 'connected' || !activeTabId) return;
    if (!await ensureAgentInstalled('claude')) return;
    pendingRestartRef.current = buildClaudeCommand(null);
    useTabStore.getState().setSessionView(activeTabId, 'check');
    sendStdin('/exit\r');
  }, [status, sendStdin, activeTabId, buildClaudeCommand, ensureAgentInstalled]);

  const buildCodexCommand = useCallback(
    () => fetchCodexLaunchCommand(layoutWsId),
    [layoutWsId],
  );

  const markAgentLaunch = useCallback((tabId: string, options?: { resetAgentSession?: boolean }) => {
    fetch('/api/status/agent-launch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tabId, resetAgentSession: options?.resetAgentSession === true }),
    }).catch(() => {});
  }, []);

  const handleNewCodexSession = useCallback(async () => {
    if (status !== 'connected' || !activeTabId) return;
    if (!await ensureAgentInstalled('codex')) return;
    let command: string;
    try {
      command = await buildCodexCommand();
    } catch {
      toast.error(t('codexLaunchFailed'));
      return;
    }
    markAgentLaunch(activeTabId, { resetAgentSession: true });
    useTabStore.getState().setSessionView(activeTabId, 'check');
    sendStdin(`${command}\r`);
  }, [status, sendStdin, activeTabId, buildCodexCommand, ensureAgentInstalled, markAgentLaunch, t]);

  const handleNewClaudeFromSessionList = useCallback(async () => {
    if (!await ensureAgentInstalled('claude')) return;
    handleSwitchPanelType('claude-code');
    void handleNewClaudeSession();
  }, [ensureAgentInstalled, handleNewClaudeSession, handleSwitchPanelType]);

  const handleNewCodexFromSessionList = useCallback(async () => {
    if (!await ensureAgentInstalled('codex')) return;
    handleSwitchPanelType('codex-cli');
    void handleNewCodexSession();
  }, [ensureAgentInstalled, handleNewCodexSession, handleSwitchPanelType]);

  const handleSelectAgentSession = useCallback(async (session: IAgentSessionEntry) => {
    if (status !== 'connected' || !activeTabId) return;
    const nextPanelType = session.provider === 'codex' ? 'codex-cli' : 'claude-code';
    if (!await ensureAgentInstalled(session.provider)) return;
    handleSwitchPanelType(nextPanelType);
    useTabStore.getState().setSessionView(activeTabId, 'check');

    if (session.provider === 'codex') {
      let command: string;
      try {
        command = await fetchCodexLaunchCommand(layoutWsId, session.sessionId);
      } catch {
        toast.error(t('codexLaunchFailed'));
        return;
      }
      markAgentLaunch(activeTabId, { resetAgentSession: false });
      sendStdin(`${command}\r`);
      return;
    }

    sendStdin(`${buildClaudeCommand(session.sessionId)}\r`);
  }, [activeTabId, buildClaudeCommand, ensureAgentInstalled, handleSwitchPanelType, layoutWsId, markAgentLaunch, sendStdin, status, t]);

  const handleRelaunchCodexSession = useCallback(async () => {
    if (status !== 'connected' || !activeTabId) return;
    if (!await ensureAgentInstalled('codex')) return;
    let command: string;
    try {
      command = await buildCodexCommand();
    } catch {
      toast.error(t('codexLaunchFailed'));
      return;
    }
    markAgentLaunch(activeTabId, { resetAgentSession: true });
    useTabStore.getState().setSessionView(activeTabId, 'check');
    sendStdin(`${command}\r`);
  }, [status, sendStdin, activeTabId, buildCodexCommand, ensureAgentInstalled, markAgentLaunch, t]);

  useEffect(() => {
    codexRelaunchRef.current = handleRelaunchCodexSession;
  }, [handleRelaunchCodexSession]);

  const handleRestartCodexSession = useCallback(async () => {
    if (status !== 'connected' || !activeTabId) return;
    if (!await ensureAgentInstalled('codex')) return;
    let command: string;
    try {
      command = await buildCodexCommand();
    } catch {
      toast.error(t('codexLaunchFailed'));
      return;
    }
    pendingRestartRef.current = command;
    markAgentLaunch(activeTabId, { resetAgentSession: true });
    useTabStore.getState().setSessionView(activeTabId, 'check');
    sendCodexQuitCommand(sendStdin);
  }, [status, sendStdin, activeTabId, buildCodexCommand, ensureAgentInstalled, markAgentLaunch, t]);

  useEffect(() => {
    const handleStartAgentRequest = (event: Event) => {
      const detail = (event as CustomEvent<{
        paneId?: string;
        tabId?: string;
        provider?: TGitAskProvider;
      }>).detail;
      if (detail?.paneId !== paneId || detail.tabId !== activeTabId) return;
      if (detail.provider !== 'claude' && detail.provider !== 'codex') return;
      const provider = detail.provider;
      void (async () => {
        if (!await ensureAgentInstalled(provider)) return;
        const panelType = provider === 'codex' ? 'codex-cli' : 'claude-code';
        useTabStore.getState().setDetectedAgent(activeTabId, {
          running: true,
          checkedAt: Date.now(),
          providerId: provider,
          panelType,
        });
        handleSwitchPanelType(panelType);
        if (provider === 'codex') {
          void handleNewCodexSession();
          return;
        }
        void handleNewClaudeSession();
      })();
    };

    window.addEventListener('purplemux-start-agent', handleStartAgentRequest);
    return () => window.removeEventListener('purplemux-start-agent', handleStartAgentRequest);
  }, [activeTabId, ensureAgentInstalled, handleNewClaudeSession, handleNewCodexSession, handleSwitchPanelType, paneId]);

  const handleSwitchToAgentMode = useCallback(async () => {
    const prompt = agentModePrompt;
    if (!activeTabId || !prompt || prompt.tabId !== activeTabId) return;
    setAgentModePrompt(null);
    handleSwitchPanelType(prompt.panelType);
    if (status !== 'connected') return;

    const resumeSessionId = prompt.resumable ? prompt.sessionId : null;

    if (prompt.panelType === 'codex-cli') {
      if (!await ensureAgentInstalled('codex')) return;
      let command: string;
      try {
        command = await fetchCodexLaunchCommand(layoutWsId, resumeSessionId);
      } catch {
        toast.error(t('codexLaunchFailed'));
        return;
      }
      pendingRestartRef.current = command;
      markAgentLaunch(activeTabId, { resetAgentSession: !resumeSessionId });
      useTabStore.getState().setSessionView(activeTabId, 'check');
      sendCodexQuitCommand(sendStdin);
      return;
    }

    if (!await ensureAgentInstalled('claude')) return;
    pendingRestartRef.current = buildClaudeCommand(resumeSessionId);
    useTabStore.getState().setSessionView(activeTabId, 'check');
    sendStdin('\x03');
    setTimeout(() => sendStdin('\x03'), 300);
  }, [activeTabId, agentModePrompt, status, ensureAgentInstalled, handleSwitchPanelType, layoutWsId, markAgentLaunch, sendStdin, t, buildClaudeCommand]);

  useEffect(() => {
    if (!pendingRestartRef.current || agentProcess === true) return;
    if (status !== 'connected') return;
    if (!isShellProcess(lastTitleRef.current)) return;
    const cmd = pendingRestartRef.current;
    pendingRestartRef.current = null;
    const tabId = activeTabIdRef.current;
    if (tabId) markAgentLaunch(tabId);
    sendStdin(`${cmd}\r`);
  }, [agentProcess, status, sendStdin, markAgentLaunch]);

  const splitGroupRef = useRef<GroupImperativeHandle>(null);
  const suppressTerminalSaveRef = useRef(false);

  const handleToggleTerminal = useCallback(() => {
    if (!splitGroupRef.current) return;
    setIsPanelTransitioning(true);
    const next = !isTerminalCollapsed;
    const ratio = activeTab?.terminalRatio ?? 30;
    setIsTerminalCollapsed(next);
    suppressTerminalSaveRef.current = true;
    splitGroupRef.current.setLayout(
      next
        ? { timeline: 100, 'terminal-area': 0 }
        : { timeline: 100 - ratio, 'terminal-area': ratio },
    );
    if (isAgentPanel && activeTabId) {
      updateTabTerminalLayout(paneId, activeTabId, { terminalCollapsed: next });
    }
    setTimeout(() => {
      setIsPanelTransitioning(false);
      suppressTerminalSaveRef.current = false;
      if (!isReady || status !== 'connected') return;
      const { cols, rows } = fit();
      sendEffectiveResize(cols, rows, next);
    }, 150);
  }, [isTerminalCollapsed, isReady, status, fit, isAgentPanel, activeTabId, paneId, activeTab?.terminalRatio, updateTabTerminalLayout, sendEffectiveResize]);

  useEffect(() => {
    if (!splitGroupRef.current) return;
    suppressTerminalSaveRef.current = true;
    if (isAgentPanel) {
      const ratio = activeTab?.terminalRatio ?? 30;
      setIsTerminalCollapsed(effectiveTerminalCollapsed);
      splitGroupRef.current.setLayout(
        effectiveTerminalCollapsed
          ? { timeline: 100, 'terminal-area': 0 }
          : { timeline: 100 - ratio, 'terminal-area': ratio },
      );
      fetchAndUpdateCwd();
    } else {
      splitGroupRef.current.setLayout({ timeline: 0, 'terminal-area': 100 });
    }
    const timer = setTimeout(() => {
      setIsPanelTransitioning(false);
      suppressTerminalSaveRef.current = false;
      if (!isReady || status !== 'connected') return;
      const { cols, rows } = fit();
      sendEffectiveResize(cols, rows, isAgentPanel ? effectiveTerminalCollapsed : false);
      if (isFocused) {
        if (isAgentPanel) {
          if (agentInputVisible) deferredFocusInput(() => focusInputRef.current?.());
        } else {
          focus();
        }
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [isAgentPanel, activeTabId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isFocused && isAgentPanel && agentInputVisible) {
      deferredFocusInput(() => focusInputRef.current?.());
    }
  }, [agentInputVisible]); // eslint-disable-line react-hooks/exhaustive-deps

  const noTabs = tabs.length === 0;
  const ready = isReady && (status === 'connected' || hasEverConnected) && !noTabs && !sessionSwitching;
  const showInitialLoading =
    !noTabs &&
    (!isReady || !hasEverConnected);

  const showKeyBar =
    activePanelType === 'terminal' &&
    !noTabs &&
    (keyBarMode === 'always' || (keyBarMode === 'auto' && isTouchDevice));

  return (
    <div
      className={cn(
        'flex h-full flex-col overflow-hidden',
        paneCount > 1 && 'border',
        paneCount > 1 && isFocused ? 'border-focus-indicator' : 'border-transparent',
      )}
      style={{
        opacity: !mounted ? 0 : undefined,
        transition: 'opacity 200ms ease-out, border-color 150ms',
      }}
      role="region"
      aria-label={`Pane ${paneNumber}`}
      aria-current={isFocused ? 'true' : undefined}
      onClick={handleFocusPane}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
    >
      <PaneTabBar
        paneId={paneId}
        tabs={tabs}
        activeTabId={activeTabId}
        tabTitles={tabTitles}
        tabProcesses={tabProcesses}
        isLoading={false}
        error={null}
        isCreating={isCreating}
        paneCount={paneCount}
        isSplitting={isSplitting}
        onSwitchTab={handleSwitchTab}
        onCreateTab={handleCreateTab}
        onDeleteTab={handleDeleteTab}
        onRenameTab={handleRenameTab}
        onSwitchPanelType={handleSwitchPanelType}
        onReorderTabs={handleReorderTabs}
        onClosePane={() => closePane(paneId)}
        onMoveTab={handleMoveTab}
        onFocusPane={handleFocusPane}
        onRetry={() => {}}
      />

      <div
        role="tabpanel"
        className="relative min-h-0 flex-1 flex flex-col"
        style={isWebBrowser || isDiff || isAgentSessionList ? undefined : { backgroundColor: terminalTheme.colors.background }}
        onDragOver={isWebBrowser || isDiff || isAgentSessionList ? undefined : handleTerminalDragOver}
        onDrop={isWebBrowser || isDiff || isAgentSessionList ? undefined : handleTerminalDrop}
      >
        {isWebBrowser && activeTabId && (
          <WebBrowserPanel
            key={activeTabId}
            tabId={activeTabId}
            initialUrl={activeTab?.webUrl}
            onUrlChange={handleWebUrlChange}
          />
        )}

        {isDiff && activeTab && (
          <DiffPanel
            key={activeTab.sessionName}
            sessionName={activeTab.sessionName}
            onSendToAgent={handleSendToAgent}
            settings={diffSettings}
            onSettingsChange={updateDiffSettings}
          />
        )}

        {isAgentSessionList && activeTab && !showInitialLoading && (
          <AgentSessionsPanel
            key={activeTab.sessionName}
            sessionName={activeTab.sessionName}
            cwd={activeTabCwd || activeTab.cwd}
            onSelectSession={handleSelectAgentSession}
            onNewClaudeSession={handleNewClaudeFromSessionList}
            onNewCodexSession={handleNewCodexFromSessionList}
          />
        )}

        <Group
          groupRef={splitGroupRef}
          orientation="vertical"
          defaultLayout={isAgentPanel
            ? (() => {
                const ratio = activeTab?.terminalRatio ?? 30;
                return effectiveTerminalCollapsed
                  ? { timeline: 100, 'terminal-area': 0 }
                  : { timeline: 100 - ratio, 'terminal-area': ratio };
              })()
            : { timeline: 0, 'terminal-area': 100 }
          }
          onLayoutChanged={(layout) => {
            if (suppressTerminalSaveRef.current) return;
            if (!isAgentPanel || !activeTabId) return;
            const area = layout['terminal-area'];
            if (area === undefined) return;
            const collapsed = area <= 0;
            const patch: { terminalRatio?: number; terminalCollapsed?: boolean } = {};
            if (collapsed !== effectiveTerminalCollapsed) {
              patch.terminalCollapsed = collapsed;
              setIsTerminalCollapsed(collapsed);
            }
            if (!collapsed) {
              const rounded = Math.round(area);
              const currentRatio = activeTab?.terminalRatio ?? 30;
              if (rounded !== currentRatio) patch.terminalRatio = rounded;
            }
            if (patch.terminalRatio !== undefined || patch.terminalCollapsed !== undefined) {
              updateTabTerminalLayout(paneId, activeTabId, patch);
            }
          }}
          className={cn('min-h-0 flex-1', (isWebBrowser || isDiff || isAgentSessionList) && 'invisible absolute inset-0 pointer-events-none', isPanelTransitioning && '[&>[data-panel]]:[transition:flex-grow_150ms_ease-out]')}
        >
          <Panel
            id="timeline"
            minSize={0}
            collapsible
            collapsedSize={0}
            disabled={!isAgentPanel}
          >
            <div
              className={cn('flex h-full flex-col bg-card', isTerminalCollapsed && 'pb-3')}
              onDragOver={isAgentPanel ? handleTimelineDragOver : undefined}
              onDrop={isAgentPanel ? handleTimelineDrop : undefined}
            >
              {isClaudeCode && activeTab && !showInitialLoading && activeTabId && (
                <ClaudeCodePanel
                  key={activeTab.sessionName}
                  tabId={activeTabId}
                  sessionName={activeTab.sessionName}
                  claudeSessionId={claudeSessionId}
                  cwd={activeTabCwd || activeTab.cwd}
                  active={isFocused}
                  onClose={() => handleSwitchPanelType('terminal')}
                  onNewSession={handleNewClaudeSession}
                  scrollToBottomRef={scrollToBottomRef}
                  addPendingMessageRef={addPendingMessageRef}
                  removePendingMessageRef={removePendingMessageRef}
                  trustPrompt={trustPrompt}
                  onTrustResponse={onTrustResponse}
                />
              )}
              {isCodex && activeTab && !showInitialLoading && activeTabId && (
                <CodexPanel
                  key={activeTab.sessionName}
                  tabId={activeTabId}
                  sessionName={activeTab.sessionName}
                  cwd={activeTabCwd || activeTab.cwd}
                  active={isFocused}
                  onClose={() => handleSwitchPanelType('terminal')}
                  onNewSession={handleNewCodexSession}
                  onRestart={handleRestartCodexSession}
                  updatePrompt={codexUpdatePrompt}
                  onUpdatePromptResponse={onCodexUpdateResponse}
                  trustPrompt={trustPrompt}
                  onTrustResponse={onTrustResponse}
                  scrollToBottomRef={scrollToBottomRef}
                  addPendingMessageRef={addPendingMessageRef}
                  removePendingMessageRef={removePendingMessageRef}
                />
              )}
              {isAgentPanel && !showInitialLoading && agentInputVisible && (
                <WebInputBar
                  key={activeTabId}
                  tabId={activeTabId ?? undefined}
                  wsId={layoutWsId ?? undefined}
                  sessionName={activeTab?.sessionName}
                  agentSessionId={claudeSessionId}
                  provider={isCodex ? 'codex' : 'claude'}
                  cliState={claudeCliState}
                  sendStdin={sendWebStdin}
                  terminalWsConnected={status === 'connected'}
                  visible
                  focusTerminal={focus}
                  focusInputRef={focusInputRef}
                  setInputValueRef={setInputValueRef}
                  onRestartSession={isCodex ? handleRestartCodexSession : handleRestartClaudeSession}
                  onSend={handleScrollToBottom}
                  onOptimisticSend={handleOptimisticSend}
                  onAddPendingMessage={handleAddPendingMessage}
                  onRemovePendingMessage={handleRemovePendingMessage}
                  attachFilesRef={attachFilesRef}
                />
              )}
              {isAgentPanel && !showInitialLoading && agentInputVisible && activeTabId && (
                <QuickPromptBar
                  prompts={quickPrompts}
                  visible
                  onSelect={handleSelectQuickPrompt}
                />
              )}
            </div>
          </Panel>

          <Separator
            className={cn(
              'group flex items-center justify-center overflow-hidden bg-card',
              isAgentPanel && !isTerminalCollapsed ? 'h-3' : 'h-0',
            )}
            disabled={!isAgentPanel || isTerminalCollapsed}
          >
            <div className="h-px w-16 rounded-full bg-border transition-colors group-hover:bg-muted-foreground group-data-[resize-handle-active]:bg-muted-foreground" />
          </Separator>

          {isAgentPanel && (
            <button
              className="flex h-6 w-full shrink-0 cursor-pointer items-center gap-1.5 border-t border-border bg-black/3 px-2 text-muted-foreground transition-colors hover:bg-black/5 dark:bg-white/3 dark:hover:bg-white/5"
              onClick={handleToggleTerminal}
            >
              <TerminalSquare className="h-3 w-3" />
              <span className="text-[11px] font-medium">Terminal</span>
              {activeTabCwd && (
                <span className="min-w-0 truncate text-[11px] opacity-60">
                  {activeTabCwd.replace(/^\/Users\/[^/]+/, '~')}
                </span>
              )}
              <span className="ml-auto flex h-4 w-4 shrink-0 items-center justify-center">
                {isTerminalCollapsed ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              </span>
            </button>
          )}

          <Panel id="terminal-area" minSize={0} collapsible collapsedSize={0}>
            <div className="flex h-full flex-col" onMouseDown={() => { clickedTerminalRef.current = true; }}>
              <TerminalContainer
                ref={terminalRef}
                minHeight={isAgentPanel ? 256 : undefined}
                className={cn(
                  'min-h-0 flex-1',
                  ready ? 'opacity-100' : 'opacity-0',
                  isAgentPanel && 'py-0 pl-2 pr-0.5',
                )}
              />
              {showKeyBar && (
                <TerminalKeyBar
                  sendStdin={sendStdin}
                  ctrlActive={ctrlArmed}
                  shiftActive={shiftArmed}
                  setCtrlActive={setCtrlArmed}
                  setShiftActive={setShiftArmed}
                />
              )}
            </div>
          </Panel>
        </Group>

        {noTabs && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3">
            <Button className="gap-1.5" onClick={() => handleCreateTab()} disabled={isCreating}>
              {isCreating ? (
                <Spinner className="h-3 w-3" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              {t('openNewTab')}
            </Button>
          </div>
        )}


        {!noTabs && activePanelType === 'terminal' && status === 'disconnected' && disconnectReason === 'session-not-found' && activeTabId && (
          <PaneDisconnectedOverlay
            cwd={activeTab?.cwd}
            lastCommand={activeTab?.lastCommand}
            onRestartWithCommand={(cmd) => handleRestartTab(activeTabId, cmd)}
            onRestartNew={() => handleRestartTab(activeTabId)}
          />
        )}

        {agentModePrompt && agentModePrompt.tabId === activeTabId && activePanelType === 'terminal' && (
          <PaneAgentModePrompt
            modeName={agentModePrompt.displayName}
            onSwitch={handleSwitchToAgentMode}
            onDismiss={() => setAgentModePrompt(null)}
          />
        )}

        {showPathInput && (
          <PanePathInputOverlay
            hint={droppedFileHint}
            onSubmit={handlePathInputSubmit}
            onDismiss={handlePathInputDismiss}
          />
        )}

        {!noTabs && !isWebBrowser && !isDiff && (
          <ConnectionStatus
            status={status}
            retryCount={retryCount}
            disconnectReason={disconnectReason}
            onReconnect={reconnect}
          />
        )}
        {installDialogs}
      </div>
    </div>
  );
});
PaneContainer.displayName = 'PaneContainer';

export default PaneContainer;
