import { useEffect, useRef } from 'react';
import useTabStore from '@/hooks/use-tab-store';
import useTabMetadataStore from '@/hooks/use-tab-metadata-store';
import useRateLimitsStore from '@/hooks/use-rate-limits-store';
import useSessionHistoryStore from '@/hooks/use-session-history-store';
import useGitStatusStore from '@/hooks/use-git-status-store';
import { useLayoutStore } from '@/hooks/use-layout';
import { formatTabTitle } from '@/lib/tab-title';
import { collectAllTabs } from '@/lib/layout-tree';
import type { ILastEvent, TStatusServerMessage } from '@/types/status';

const RECONNECT_BASE = 1_000;
const RECONNECT_MAX = 30_000;

let sharedWs: WebSocket | null = null;

export const dismissTab = (tabId: string) => {
  useTabStore.getState().dismissTab(tabId);
  if (sharedWs?.readyState === WebSocket.OPEN) {
    sharedWs.send(JSON.stringify({ type: 'status:tab-dismissed', tabId }));
  }
};

export const requestSync = () => {
  if (sharedWs?.readyState === WebSocket.OPEN) {
    sharedWs.send(JSON.stringify({ type: 'status:request-sync' }));
  }
};

export const ackNotificationInput = (tabId: string, seq: number) => {
  if (sharedWs?.readyState === WebSocket.OPEN) {
    sharedWs.send(JSON.stringify({ type: 'status:ack-notification', tabId, seq }));
  }
};

const refreshGitStatusAfterStop = (tabId: string, event: ILastEvent) => {
  if (event.name !== 'stop') return;

  const gitState = useGitStatusStore.getState();
  if (!gitState.cwdKey || !gitState.tmuxSession) return;

  const layout = useLayoutStore.getState().layout;
  if (!layout) return;

  const tab = collectAllTabs(layout.root).find((item) => item.id === tabId);
  if (!tab || tab.sessionName !== gitState.tmuxSession) return;

  void gitState.fetchForTarget(
    { cwdKey: gitState.cwdKey, tmuxSession: gitState.tmuxSession },
    { force: true },
  );
};

const useAgentStatus = () => {
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    const connect = () => {
      if (!mountedRef.current) return;

      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${location.host}/api/status`);
      sharedWs = ws;

      ws.onopen = () => {
        if (!mountedRef.current) return;
        retryCountRef.current = 0;
        useTabStore.getState().setStatusWsConnected(true);
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current) return;
        try {
          const msg = JSON.parse(event.data) as TStatusServerMessage;

          switch (msg.type) {
            case 'status:sync': {
              useTabStore.getState().syncAllFromServer(msg.tabs);
              for (const [tabId, entry] of Object.entries(msg.tabs)) {
                if (entry.panelType === 'agent-sessions') continue;
                if (entry.paneTitle && !useTabMetadataStore.getState().metadata[tabId]?.title) {
                  useTabMetadataStore.getState().setTitle(tabId, formatTabTitle(entry.paneTitle, entry.panelType));
                }
              }
              break;
            }

            case 'status:update':
              useTabStore.getState().updateFromServer(msg.tabId, {
                cliState: msg.cliState,
                workspaceId: msg.workspaceId,
                tabName: msg.tabName,
                panelType: msg.panelType,
                terminalStatus: msg.terminalStatus,
                listeningPorts: msg.listeningPorts,
                currentProcess: msg.currentProcess,
                agentProviderId: msg.agentProviderId,
                agentSessionId: msg.agentSessionId,
                agentSummary: msg.agentSummary,
                lastUserMessage: msg.lastUserMessage,
                lastAssistantMessage: msg.lastAssistantMessage,
                currentAction: msg.currentAction,
                readyForReviewAt: msg.readyForReviewAt,
                busySince: msg.busySince,
                dismissedAt: msg.dismissedAt,
                compactingSince: msg.compactingSince,
                permissionRequest: msg.permissionRequest,
                pendingQuestions: msg.pendingQuestions,
                lastEvent: msg.lastEvent,
                eventSeq: msg.eventSeq,
              });
              if (msg.paneTitle && msg.panelType !== 'agent-sessions') {
                useTabMetadataStore.getState().setTitle(msg.tabId, formatTabTitle(msg.paneTitle, msg.panelType));
              }
              break;

            case 'status:hook-event':
              useTabStore.getState().applyHookEvent(msg.tabId, msg.event);
              refreshGitStatusAfterStop(msg.tabId, msg.event);
              break;

            case 'rate-limits:update':
              useRateLimitsStore.getState().setData(msg.data);
              break;

            case 'session-history:sync':
              useSessionHistoryStore.getState().syncFromServer(msg.entries);
              break;

            case 'session-history:update':
              useSessionHistoryStore.getState().upsertEntry(msg.entry);
              break;
          }
        } catch {
          // invalid message
        }
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        useTabStore.getState().setStatusWsConnected(false);
        sharedWs = null;

        const delay = Math.min(
          RECONNECT_BASE * Math.pow(2, retryCountRef.current),
          RECONNECT_MAX,
        );
        retryCountRef.current++;
        retryTimerRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose will fire after onerror
      };
    };

    connect();

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      const state = sharedWs?.readyState;
      if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      retryCountRef.current = 0;
      connect();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      mountedRef.current = false;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (sharedWs) {
        sharedWs.close();
        sharedWs = null;
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);
};

export default useAgentStatus;
