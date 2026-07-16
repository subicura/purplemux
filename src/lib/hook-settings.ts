import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createLogger } from '@/lib/logger';
import { STATUSLINE_SCRIPT_PATH, STATUSLINE_SCRIPT_CONTENT } from '@/lib/statusline-script';

const log = createLogger('hooks');
const codexLog = createLogger('codex-hook');

const BASE_DIR = path.join(os.homedir(), '.purplemux');
const HOOKS_FILE = path.join(BASE_DIR, 'hooks.json');
const PORT_FILE = path.join(BASE_DIR, 'port');
const HOOK_SCRIPT = path.join(BASE_DIR, 'status-hook.sh');
const CODEX_HOOK_SCRIPT = path.join(BASE_DIR, 'codex-hook.sh');

export const HOOK_SETTINGS_PATH = HOOKS_FILE;
export const CODEX_HOOK_SCRIPT_PATH = CODEX_HOOK_SCRIPT;

const HOOK_SCRIPT_CONTENT = `#!/bin/sh
EVENT="\${1:-poll}"
PORT_FILE="$HOME/.purplemux/port"
TOKEN_FILE="$HOME/.purplemux/cli-token"
[ -f "$PORT_FILE" ] || exit 0
[ -f "$TOKEN_FILE" ] || exit 0
PORT=$(cat "$PORT_FILE")
TOKEN=$(cat "$TOKEN_FILE")

resolve_tmux_session() {
  SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null || true)
  if [ -n "$SESSION" ]; then
    printf '%s\\n' "$SESSION"
    return
  fi

  PID=$$
  while [ -n "$PID" ] && [ "$PID" != "1" ]; do
    SESSION=$(tmux -L purple list-panes -a -F '#{session_name} #{pane_pid}' 2>/dev/null | awk -v pid="$PID" '$2 == pid { print $1; exit }')
    if [ -n "$SESSION" ]; then
      printf '%s\\n' "$SESSION"
      return
    fi
    PID=$(ps -o ppid= -p "$PID" 2>/dev/null | tr -d ' ')
  done
}

SESSION=$(resolve_tmux_session)

if [ "$EVENT" = "pre-tool-use" ] || [ "$EVENT" = "post-tool-use" ]; then
  curl -sS -X POST -o /dev/null \\
    -H "x-pmux-token: \${TOKEN}" \\
    -H "Content-Type: application/json" \\
    --data-binary @- \\
    "http://localhost:\${PORT}/api/status/hook?event=\${EVENT}&session=\${SESSION}" 2>/dev/null || true
  exit 0
fi

NOTIFICATION_TYPE=""
if [ "$EVENT" = "notification" ]; then
  NOTIFICATION_TYPE=$(sed -n 's/.*"notification_type"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')
fi

PAYLOAD="{\\"event\\":\\"\${EVENT}\\",\\"session\\":\\"\${SESSION}\\""
if [ -n "$NOTIFICATION_TYPE" ]; then
  PAYLOAD="\${PAYLOAD},\\"notificationType\\":\\"\${NOTIFICATION_TYPE}\\""
fi
PAYLOAD="\${PAYLOAD}}"

curl -s -X POST -o /dev/null -H 'Content-Type: application/json' -H "x-pmux-token: \${TOKEN}" -d "$PAYLOAD" "http://localhost:\${PORT}/api/status/hook" 2>/dev/null
exit 0
`;

const CODEX_HOOK_SCRIPT_CONTENT = `#!/usr/bin/env bash
set -u
PORT_FILE="$HOME/.purplemux/port"
TOKEN_FILE="$HOME/.purplemux/cli-token"
[ -f "$PORT_FILE" ] || exit 0
[ -f "$TOKEN_FILE" ] || exit 0
PORT=$(cat "$PORT_FILE")
TOKEN=$(cat "$TOKEN_FILE")

resolve_tmux_session() {
  SESSION=$(tmux display-message -p '#{session_name}' 2>/dev/null || true)
  if [ -n "$SESSION" ]; then
    printf '%s\\n' "$SESSION"
    return
  fi

  PID=$$
  while [ -n "$PID" ] && [ "$PID" != "1" ]; do
    SESSION=$(tmux -L purple list-panes -a -F '#{session_name} #{pane_pid}' 2>/dev/null | awk -v pid="$PID" '$2 == pid { print $1; exit }')
    if [ -n "$SESSION" ]; then
      printf '%s\\n' "$SESSION"
      return
    fi
    PID=$(ps -o ppid= -p "$PID" 2>/dev/null | tr -d ' ')
  done
}

SESSION=$(resolve_tmux_session)

curl -sS -X POST -o /dev/null \\
  -H "x-pmux-token: \${TOKEN}" \\
  -H "Content-Type: application/json" \\
  --data-binary @- \\
  "http://localhost:\${PORT}/api/status/hook?provider=codex&tmuxSession=\${SESSION}" 2>/dev/null || true
exit 0
`;

const hookEntry = (event: string, matcher = '', timeout = 3) => [
  {
    matcher,
    hooks: [
      {
        type: 'command',
        command: `sh "${HOOK_SCRIPT}" ${event}`,
        timeout,
      },
    ],
  },
];

const buildHookSettings = () => ({
  hooks: {
    SessionStart: hookEntry('session-start'),
    UserPromptSubmit: hookEntry('prompt-submit'),
    Notification: hookEntry('notification'),
    Stop: hookEntry('stop'),
    StopFailure: hookEntry('stop'),
    PreCompact: hookEntry('pre-compact'),
    PostCompact: hookEntry('post-compact'),
    PreToolUse: hookEntry('pre-tool-use', 'AskUserQuestion'),
    PostToolUse: hookEntry('post-tool-use', 'AskUserQuestion'),
  },
  statusLine: {
    type: 'command' as const,
    command: `sh "${STATUSLINE_SCRIPT_PATH}"`,
  },
});

const writeManagedScript = async (target: string, body: string, mode: number): Promise<void> => {
  try {
    const existing = await fs.readFile(target, 'utf-8');
    if (existing !== body) {
      await fs.writeFile(target, body, { mode });
    }
  } catch {
    await fs.writeFile(target, body, { mode });
  }
};

export interface IEnsureHookSettingsResult {
  codexHookInstallFailed: boolean;
}

export const ensureHookSettings = async (port: number): Promise<IEnsureHookSettingsResult> => {
  await fs.mkdir(BASE_DIR, { recursive: true });

  await fs.writeFile(PORT_FILE, String(port), { mode: 0o600 });

  await writeManagedScript(HOOK_SCRIPT, HOOK_SCRIPT_CONTENT, 0o755);
  await writeManagedScript(STATUSLINE_SCRIPT_PATH, STATUSLINE_SCRIPT_CONTENT, 0o755);

  let codexHookInstallFailed = false;
  try {
    await writeManagedScript(CODEX_HOOK_SCRIPT, CODEX_HOOK_SCRIPT_CONTENT, 0o700);
  } catch (err) {
    codexHookInstallFailed = true;
    codexLog.error({ err }, 'codex-hook script write failed');
  }

  const settings = buildHookSettings();
  const content = JSON.stringify(settings, null, 2) + '\n';

  try {
    const existing = await fs.readFile(HOOKS_FILE, 'utf-8');
    if (existing === content) return { codexHookInstallFailed };
  } catch {
    // file doesn't exist yet
  }

  await fs.writeFile(HOOKS_FILE, content, { mode: 0o600 });
  log.debug(`${HOOKS_FILE} created`);
  return { codexHookInstallFailed };
};

export const removePortFile = async (): Promise<void> => {
  try {
    await fs.unlink(PORT_FILE);
  } catch {
    // already removed
  }
};
