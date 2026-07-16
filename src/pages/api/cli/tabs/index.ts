import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyCliToken } from '@/lib/cli-token';
import { getLayout, addTabToPane } from '@/lib/layout-store';
import { collectPanes } from '@/lib/layout-tree';
import { getWorkspaceById, getWorkspaces } from '@/lib/workspace-store';
import { resolveFirstPaneId } from '@/lib/cli-utils';
import { getProviderByPanelType } from '@/lib/providers';
import { checkAgentAvailabilityForPanelType, toAgentAvailabilityError } from '@/lib/agent-availability';
import { createLogger } from '@/lib/logger';
import type { TPanelType } from '@/types/terminal';

const log = createLogger('api:cli:tabs');

const VALID_PANEL_TYPES: TPanelType[] = ['terminal', 'claude-code', 'codex-cli', 'agent-sessions', 'web-browser', 'diff'];

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!verifyCliToken(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (req.method === 'GET') {
    const wsId = typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined;
    const tabs: Array<{
      tabId: string;
      workspaceId: string;
      name: string;
      sessionName: string;
      panelType?: string;
      agentProviderId: string | null;
      agentSessionId: string | null;
    }> = [];

    const workspaceIds = wsId ? [wsId] : (await getWorkspaces()).workspaces.map((w) => w.id);

    for (const id of workspaceIds) {
      const ws = await getWorkspaceById(id);
      if (!ws) continue;
      const layout = await getLayout(id);
      for (const pane of collectPanes(layout.root)) {
        for (const tab of pane.tabs) {
          const provider = getProviderByPanelType(tab.panelType);
          tabs.push({
            tabId: tab.id,
            workspaceId: id,
            name: tab.name,
            sessionName: tab.sessionName,
            panelType: tab.panelType,
            agentProviderId: provider?.id ?? null,
            agentSessionId: provider?.readSessionId(tab) ?? null,
          });
        }
      }
    }
    return res.status(200).json({ tabs });
  }

  if (req.method === 'POST') {
    const { workspaceId, name, panelType, command } = req.body as {
      workspaceId?: string;
      name?: string;
      panelType?: string;
      command?: string;
    };
    if (!workspaceId) {
      return res.status(400).json({ error: 'workspaceId is required' });
    }
    const ws = await getWorkspaceById(workspaceId);
    if (!ws) {
      return res.status(404).json({ error: 'Workspace not found' });
    }
    const paneId = await resolveFirstPaneId(workspaceId);
    if (!paneId) {
      return res.status(500).json({ error: 'No pane available in workspace' });
    }
    if (panelType !== undefined && !VALID_PANEL_TYPES.includes(panelType as TPanelType)) {
      return res.status(400).json({
        error: 'Invalid panelType',
        validPanelTypes: VALID_PANEL_TYPES,
      });
    }
    const resolvedType: TPanelType = panelType ? (panelType as TPanelType) : 'terminal';
    const launchCommand = typeof command === 'string' && command.trim() ? command : undefined;
    const availability = await checkAgentAvailabilityForPanelType(resolvedType);
    if (!availability.ok) {
      return res.status(availability.status).json(toAgentAvailabilityError(availability));
    }

    try {
      const tab = await addTabToPane(workspaceId, paneId, name, ws.directories[0], resolvedType, launchCommand);
      if (!tab) return res.status(500).json({ error: 'Failed to create tab' });
      return res.status(201).json({
        tabId: tab.id,
        workspaceId,
        paneId,
        sessionName: tab.sessionName,
        name: tab.name,
        panelType: tab.panelType,
        agentProviderId: null,
        agentSessionId: null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      log.error(`create tab failed: ${msg}`);
      return res.status(500).json({ error: msg });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
