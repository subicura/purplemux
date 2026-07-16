import path from 'path';
import os from 'os';

const BASE_DIR = path.join(os.homedir(), '.purplemux');
export const STATUSLINE_SCRIPT_PATH = path.join(BASE_DIR, 'statusline.sh');
export const RATE_LIMITS_FILE = path.join(BASE_DIR, 'rate-limits.json');

export const STATUSLINE_SCRIPT_CONTENT = `#!/bin/sh
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

TMUX_SESSION=$(resolve_tmux_session)
URL="http://localhost:\${PORT}/api/status/statusline?provider=claude"
if [ -n "$TMUX_SESSION" ]; then
  URL="\${URL}&tmuxSession=\${TMUX_SESSION}"
fi
curl -sf --max-time 2 -X POST \\
  -H 'Content-Type: application/json' \\
  -H "x-pmux-token: \${TOKEN}" \\
  --data-binary @- \\
  "\${URL}" 2>/dev/null || exit 0
`;
