import fs from 'fs/promises';
import path from 'path';
import { resolveLayoutDir } from '@/lib/layout-store';
import type { IWorkspace } from '@/types/terminal';

export const getCodexPromptPath = (workspaceId: string): string =>
  path.join(resolveLayoutDir(workspaceId), 'codex-prompt.md');

export const sanitizeForTomlTripleQuote = (s: string): string =>
  s.replace(/'''/g, "' ''");

export const toTomlBasicString = (s: string): string => JSON.stringify(s);

const buildBody = (ws: IWorkspace): string => {
  const raw = `# purplemux context

You are running inside a purplemux workspace tab via OpenAI Codex CLI.

- **Workspace ID**: \`${ws.id}\`

Use \`purplemux workspaces\` if you need the workspace name or directories.

## purplemux CLI

The \`purplemux\` CLI lets you inspect and control other tabs in this workspace.
It reads port and token from \`~/.purplemux/{port,cli-token}\` automatically,
so no environment setup is needed.

### Commands

\`\`\`bash
purplemux workspaces                                # list all workspaces
purplemux tab list -w ${ws.id}                        # list tabs in this workspace
purplemux tab create -w ${ws.id} [-n NAME] [-t TYPE] [-c CMD]  # create a tab (type: terminal | claude-code | codex-cli | agent-sessions | web-browser | diff)
purplemux tab send -w ${ws.id} TAB_ID CONTENT...      # send input to a tab
purplemux tab status -w ${ws.id} TAB_ID               # tab status
purplemux tab result -w ${ws.id} TAB_ID               # capture current pane content
purplemux tab close -w ${ws.id} TAB_ID                # close a tab
\`\`\`

For the full HTTP API reference (including endpoint paths and payloads),
run:

\`\`\`bash
purplemux api-guide
\`\`\`

### When to use

- Delegate work to another tab when a task benefits from isolation
  (long-running builds, different project context, parallel exploration).
- Poll \`status\` and read \`result\` to verify delegated work.
- Prefer small, scoped tabs over cramming everything into one session.
- When creating a \`claude-code\` tab that should run Claude Code, pass the
  full launch command with hooks via \`-c\`; do not start it later with plain
  \`claude\`, because that bypasses purplemux status and timeline hooks.

### Tab type notes

- **\`web-browser\` tabs**: Electron webviews, not tmux. The \`alive\` field in
  \`tab list\` / \`tab status\` is always \`false\` for these — that is the normal
  value, not a sign the tab is dead. Do not gate actions on \`alive\`. Use the
  browser-specific HTTP endpoints (\`/browser/url\`, \`/browser/screenshot\`, …;
  see \`purplemux api-guide\`) directly.
- **\`terminal\` / \`claude-code\` / \`codex-cli\` tabs**: run inside tmux, so
  \`alive\` is a valid liveness signal.
`;
  return sanitizeForTomlTripleQuote(raw);
};

export const writeCodexPromptFile = async (ws: IWorkspace): Promise<void> => {
  const filePath = getCodexPromptPath(ws.id);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body = buildBody(ws);
  try {
    const existing = await fs.readFile(filePath, 'utf-8');
    if (existing === body) return;
  } catch {
    // missing — write below
  }
  await fs.writeFile(filePath, body, 'utf-8');
};
