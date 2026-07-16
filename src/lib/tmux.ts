import { execFile as execFileCb } from 'child_process';
import fs from 'fs/promises';
import { promisify } from 'util';
import path from 'path';
import { nanoid } from 'nanoid';
import { PRISTINE_ENV } from '@/lib/pristine-env';
import { buildShellLaunchCommand } from '@/lib/shell-env';
import { createLogger } from '@/lib/logger';
import { isLinux } from '@/lib/platform';
import { getProcessArgs } from '@/lib/process-utils';

const log = createLogger('terminal');

const execFile = promisify(execFileCb);

const TMUX_SOCKET = 'purple';
const TMUX_CONFIG_PATH = path.join(process.env.__PMUX_APP_DIR_UNPACKED || process.env.__PMUX_APP_DIR || process.cwd(), 'src', 'config', 'tmux.conf');
const CMD_TIMEOUT = 5000;

export const listSessions = async (): Promise<string[]> => {
  try {
    const { stdout } = await execFile(
      'tmux',
      ['-L', TMUX_SOCKET, 'ls', '-F', '#{session_name}'],
      { timeout: CMD_TIMEOUT },
    );
    return stdout
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter((name) => name.startsWith('pt-'));
  } catch {
    return [];
  }
};

export const createSession = async (
  name: string,
  cols: number,
  rows: number,
  cwd?: string,
): Promise<void> => {
  // tmux 서버 global env cache를 우회하기 위해 `env -i $SHELL -l`을 명령으로 직접 넘긴다.
  // execFile의 env 옵션은 tmux 서버가 이미 떠있는 경우 무시되므로 의존하지 않는다.
  const shellCmd = buildShellLaunchCommand();
  await execFile(
    'tmux',
    [
      '-u',
      '-L', TMUX_SOCKET,
      '-f', TMUX_CONFIG_PATH,
      'new-session', '-d',
      '-s', name,
      '-x', String(cols),
      '-y', String(rows),
      shellCmd,
    ],
    {
      timeout: CMD_TIMEOUT,
      cwd: cwd || PRISTINE_ENV.HOME || '/',
    },
  );
  await applyConfig();
  log.debug(`tmux session created: ${name} (cols: ${cols}, rows: ${rows})`);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const killSession = async (name: string): Promise<void> => {
  if (!(await hasSession(name))) return;

  log.debug(`killSession start: ${name}`);
  const panePid = await getSessionPanePid(name);
  if (panePid) {
    try {
      log.debug(`SIGTERM → process group ${panePid}: ${name}`);
      process.kill(-panePid, 'SIGTERM');
    } catch {
      // process group already gone
    }
  }

  try {
    await execFile(
      'tmux',
      ['-L', TMUX_SOCKET, 'kill-session', '-t', name],
      { timeout: CMD_TIMEOUT },
    );
  } catch {
    // kill-session failed, will verify below
  }

  for (let i = 0; i < 5; i++) {
    if (!(await hasSession(name))) {
      log.debug(`killSession done (SIGTERM): ${name}`);
      return;
    }
    await sleep(200);
  }

  // Still alive — escalate to SIGKILL
  log.warn(`session survived SIGTERM, escalating to SIGKILL: ${name}`);
  if (panePid) {
    try {
      log.debug(`SIGKILL → process group ${panePid}: ${name}`);
      process.kill(-panePid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  try {
    await execFile(
      'tmux',
      ['-L', TMUX_SOCKET, 'kill-session', '-t', name],
      { timeout: CMD_TIMEOUT },
    );
  } catch {
    // already gone
  }

  for (let i = 0; i < 3; i++) {
    if (!(await hasSession(name))) {
      log.debug(`killSession done (SIGKILL): ${name}`);
      return;
    }
    await sleep(200);
  }

  log.warn(`tmux session still alive after kill: ${name}`);
};

export const resolveExistingDir = async (preferred?: string): Promise<string> => {
  const fallback = PRISTINE_ENV.HOME || '/';
  if (!preferred) return fallback;
  let candidate = preferred;
  while (true) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      // walk up
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return fallback;
    candidate = parent;
  }
};

export const hasSession = async (name: string): Promise<boolean> => {
  try {
    await execFile(
      'tmux',
      ['-L', TMUX_SOCKET, 'has-session', '-t', name],
      { timeout: CMD_TIMEOUT },
    );
    return true;
  } catch {
    return false;
  }
};

// tmux auto-cleans dead sessions when remain-on-exit is not set, no extra handling needed
export const cleanDeadSessions = async (): Promise<void> => {};

export const scanSessions = async (): Promise<void> => {
  await cleanDeadSessions();
  const sessions = await listSessions();
  if (sessions.length > 0) {
    sessions.forEach((name) => {
      log.debug(`existing tmux session found: ${name}`);
    });
  }
};

const readShellCwd = async (pid: number): Promise<string | null> => {
  if (isLinux) {
    try {
      return await fs.readlink(`/proc/${pid}/cwd`);
    } catch {
      return null;
    }
  }
  try {
    const { stdout } = await execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: CMD_TIMEOUT });
    const line = stdout.split('\n').find((l) => l.startsWith('n/'));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
};

export const getSessionCwd = async (sessionName: string): Promise<string | null> => {
  const shellPid = await getSessionPanePid(sessionName);
  if (shellPid) {
    const cwd = await readShellCwd(shellPid);
    if (cwd) return cwd;
  }
  try {
    const { stdout } = await execFile(
      'tmux',
      ['-L', TMUX_SOCKET, 'display-message', '-p', '-t', sessionName, '#{pane_current_path}'],
      { timeout: CMD_TIMEOUT },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

export const getSessionPanePid = async (sessionName: string): Promise<number | null> => {
  try {
    const { stdout } = await execFile(
      'tmux',
      ['-L', TMUX_SOCKET, 'display-message', '-p', '-t', sessionName, '#{pane_pid}'],
      { timeout: CMD_TIMEOUT },
    );
    const pid = parseInt(stdout.trim(), 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
};

export const applyConfig = async (): Promise<void> => {
  try {
    await execFile(
      'tmux',
      ['-L', TMUX_SOCKET, 'source-file', TMUX_CONFIG_PATH],
      { timeout: CMD_TIMEOUT },
    );
  } catch {
    // Server not running yet, config will be applied on first session
  }
};

export const defaultSessionName = (): string =>
  `pt-${nanoid(6)}-${nanoid(6)}-${nanoid(6)}`;

export const workspaceSessionName = (wsId: string, paneId: string, tabId: string): string =>
  `pt-${wsId}-${paneId}-${tabId}`;

export const getPaneCurrentCommand = async (
  sessionName: string,
): Promise<string | null> => {
  try {
    const { stdout } = await execFile(
      'tmux',
      ['-L', TMUX_SOCKET, 'list-panes', '-t', sessionName, '-F', '#{pane_current_command}'],
      { timeout: CMD_TIMEOUT },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

export interface IPaneInfo {
  command: string;
  path: string;
  pid: number;
  windowActivity: number;
}

export const getAllPanesInfo = async (): Promise<Map<string, IPaneInfo>> => {
  try {
    const { stdout } = await execFile(
      'tmux',
      ['-L', TMUX_SOCKET, 'list-panes', '-a', '-F', '#{session_name}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_pid}\t#{window_activity}'],
      { timeout: CMD_TIMEOUT },
    );
    const result = new Map<string, IPaneInfo>();
    for (const line of stdout.trim().split('\n')) {
      if (!line) continue;
      const [session, command, path, pidStr, activityStr] = line.split('\t');
      if (session && command) {
        const pid = parseInt(pidStr, 10);
        const windowActivity = parseInt(activityStr, 10);
        result.set(session, {
          command,
          path: path || '',
          pid: Number.isNaN(pid) ? 0 : pid,
          windowActivity: Number.isNaN(windowActivity) ? 0 : windowActivity,
        });
      }
    }
    return result;
  } catch {
    return new Map();
  }
};

export const SAFE_SHELLS = new Set(['bash', 'zsh', 'fish', 'sh', 'dash']);

export const checkTerminalProcess = async (
  tmuxSession: string,
): Promise<{ isSafe: boolean; processName: string }> => {
  const command = await getPaneCurrentCommand(tmuxSession);
  if (!command) {
    return { isSafe: false, processName: 'unknown' };
  }
  return {
    isSafe: SAFE_SHELLS.has(command),
    processName: command,
  };
};

export const getPaneTitle = async (sessionName: string): Promise<string | null> => {
  try {
    const { stdout } = await execFile(
      'tmux',
      ['-L', TMUX_SOCKET, 'display-message', '-p', '-t', sessionName, '#{pane_title}'],
      { timeout: CMD_TIMEOUT },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
};

export const exitCopyMode = async (sessionName: string): Promise<void> => {
  await execFile(
    'tmux',
    ['-L', TMUX_SOCKET, 'copy-mode', '-q', '-t', sessionName],
    { timeout: CMD_TIMEOUT },
  ).catch(() => {});
};

export const sendKeys = async (
  sessionName: string,
  command: string,
): Promise<void> => {
  await exitCopyMode(sessionName);
  await execFile(
    'tmux',
    ['-L', TMUX_SOCKET, 'send-keys', '-t', sessionName, command, 'Enter'],
    { timeout: CMD_TIMEOUT },
  );
};

// Send text and Enter as two separate tmux invocations split by 50ms.
// Codex (and possibly other TUIs) interprets a single send-keys "cmd Enter"
// burst as a paste containing a literal newline. Splitting forces the agent
// to commit text first, then receive Enter as a discrete keypress.
export const sendKeysSeparated = async (
  sessionName: string,
  text: string,
): Promise<void> => {
  await exitCopyMode(sessionName);
  await execFile(
    'tmux',
    ['-L', TMUX_SOCKET, 'send-keys', '-t', sessionName, text],
    { timeout: CMD_TIMEOUT },
  );
  await sleep(50);
  await execFile(
    'tmux',
    ['-L', TMUX_SOCKET, 'send-keys', '-t', sessionName, 'Enter'],
    { timeout: CMD_TIMEOUT },
  );
};

export const sendRawKeys = async (
  sessionName: string,
  keys: string,
): Promise<void> => {
  await exitCopyMode(sessionName);
  await execFile(
    'tmux',
    ['-L', TMUX_SOCKET, 'send-keys', '-t', sessionName, keys],
    { timeout: CMD_TIMEOUT },
  );
};

export const sendLiteralInput = async (
  sessionName: string,
  input: string,
): Promise<void> => {
  await exitCopyMode(sessionName);
  await execFile(
    'tmux',
    ['-L', TMUX_SOCKET, 'send-keys', '-l', '-t', sessionName, input],
    { timeout: CMD_TIMEOUT },
  );
};

/** Send text via bracketed paste mode and press Enter twice (handles Claude Code long input confirmation) */
export const sendBracketedPaste = async (
  sessionName: string,
  content: string,
): Promise<void> => {
  await exitCopyMode(sessionName);
  await execFile(
    'tmux',
    ['-L', TMUX_SOCKET, 'send-keys', '-t', sessionName, '-l', `\x1b[200~${content}\x1b[201~`],
    { timeout: CMD_TIMEOUT },
  );
  await execFile(
    'tmux',
    ['-L', TMUX_SOCKET, 'send-keys', '-t', sessionName, 'Enter'],
    { timeout: CMD_TIMEOUT },
  );
  await new Promise((resolve) => setTimeout(resolve, 600));
  await execFile(
    'tmux',
    ['-L', TMUX_SOCKET, 'send-keys', '-t', sessionName, 'Enter'],
    { timeout: CMD_TIMEOUT },
  );
};


export interface IPaneDetailInfo {
  cwd: string | null;
  command: string | null;
  pid: number | null;
  width: number | null;
  height: number | null;
  sessionCreated: number | null;
}

export const getPaneDetailInfo = async (
  sessionName: string,
): Promise<IPaneDetailInfo> => {
  try {
    const { stdout } = await execFile(
      'tmux',
      [
        '-L', TMUX_SOCKET,
        'display-message', '-p', '-t', sessionName,
        '#{pane_current_path}\t#{pane_current_command}\t#{pane_pid}\t#{pane_width}\t#{pane_height}\t#{session_created}',
      ],
      { timeout: CMD_TIMEOUT },
    );
    const [cwdStr, command, pidStr, widthStr, heightStr, createdStr] = stdout.trim().split('\t');
    return {
      cwd: cwdStr || null,
      command: command || null,
      pid: pidStr ? parseInt(pidStr, 10) || null : null,
      width: widthStr ? parseInt(widthStr, 10) || null : null,
      height: heightStr ? parseInt(heightStr, 10) || null : null,
      sessionCreated: createdStr ? parseInt(createdStr, 10) || null : null,
    };
  } catch {
    return { cwd: null, command: null, pid: null, width: null, height: null, sessionCreated: null };
  }
};

const INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'perl', 'deno', 'bun']);

const cleanCommandLine = (raw: string): string => {
  const parts = raw.split(/\s+/);
  if (parts.length === 0) return raw;

  parts[0] = path.basename(parts[0]);

  if (INTERPRETERS.has(parts[0]) && parts.length > 1) {
    const scriptName = path.basename(parts[1]).replace(/\.(c|m)?js$/, '');
    parts.splice(0, 2, scriptName);
  }

  return parts.join(' ');
};

export const killServer = async (): Promise<void> => {
  try {
    await execFile(
      'tmux',
      ['-L', TMUX_SOCKET, 'kill-server'],
      { timeout: CMD_TIMEOUT },
    );
    log.debug('tmux server killed');
  } catch {
    // Server may not be running
  }
};

export const capturePaneContent = async (sessionName: string): Promise<string | null> => {
  try {
    const { stdout } = await execFile(
      'tmux',
      ['-L', TMUX_SOCKET, 'capture-pane', '-p', '-t', sessionName],
      { timeout: CMD_TIMEOUT },
    );
    return stdout;
  } catch {
    return null;
  }
};

export const capturePaneContentWithHistory = async (
  sessionName: string,
  historyLines: number,
): Promise<string | null> => {
  try {
    const { stdout } = await execFile(
      'tmux',
      ['-L', TMUX_SOCKET, 'capture-pane', '-p', '-S', `-${historyLines}`, '-t', sessionName],
      { timeout: CMD_TIMEOUT },
    );
    return stdout;
  } catch {
    return null;
  }
};

const getChildPidsOf = async (parentPids: number[]): Promise<number[]> => {
  if (isLinux) {
    const results: number[] = [];
    await Promise.all(
      parentPids.map(async (pid) => {
        try {
          const raw = await fs.readFile(`/proc/${pid}/task/${pid}/children`, 'utf-8');
          for (const s of raw.trim().split(/\s+/)) {
            const n = parseInt(s, 10);
            if (!Number.isNaN(n)) results.push(n);
          }
        } catch {
          // process gone
        }
      }),
    );
    return results;
  }
  try {
    const { stdout } = await execFile('pgrep', ['-P', parentPids.join(',')], { timeout: CMD_TIMEOUT });
    return stdout.trim().split('\n').map((s) => parseInt(s, 10)).filter((n) => !Number.isNaN(n));
  } catch {
    return [];
  }
};

const getDescendantPids = async (rootPid: number): Promise<number[]> => {
  const all: number[] = [];
  let frontier = [rootPid];
  while (frontier.length > 0) {
    const children = await getChildPidsOf(frontier);
    if (children.length === 0) break;
    all.push(...children);
    frontier = children;
  }
  return all;
};

const getListeningPortsLinux = async (pids: number[]): Promise<number[]> => {
  try {
    const pidSet = new Set(pids);
    const { stdout } = await execFile('ss', ['-tlnp'], { timeout: CMD_TIMEOUT });
    const ports = new Set<number>();
    for (const line of stdout.split('\n')) {
      const pidMatch = line.match(/pid=(\d+)/g);
      if (!pidMatch) continue;
      const hasPid = pidMatch.some((m) => pidSet.has(parseInt(m.replace('pid=', ''), 10)));
      if (!hasPid) continue;
      const portMatch = line.match(/:(\d+)\s/);
      if (portMatch) ports.add(parseInt(portMatch[1], 10));
    }
    return [...ports].sort((a, b) => a - b);
  } catch {
    return [];
  }
};

export const getListeningPorts = async (shellPid: number): Promise<number[]> => {
  const pids = await getDescendantPids(shellPid);
  if (pids.length === 0) return [];

  if (isLinux) return getListeningPortsLinux(pids);

  try {
    const { stdout } = await execFile(
      'lsof',
      ['-a', '-p', pids.join(','), '-i', '-sTCP:LISTEN', '-P', '-Fn'],
      { timeout: CMD_TIMEOUT },
    );
    const ports = new Set<number>();
    for (const line of stdout.split('\n')) {
      if (line.startsWith('n')) {
        const match = line.match(/:(\d+)$/);
        if (match) ports.add(parseInt(match[1], 10));
      }
    }
    return [...ports].sort((a, b) => a - b);
  } catch {
    return [];
  }
};

export const getLastCommand = async (sessionName: string): Promise<string | null> => {
  const shellPid = await getSessionPanePid(sessionName);
  if (!shellPid) return null;

  try {
    const { stdout: pgrepOut } = await execFile(
      'pgrep', ['-n', '-P', String(shellPid)],
      { timeout: CMD_TIMEOUT },
    );
    const childPid = pgrepOut.trim();
    if (!childPid) return null;

    const args = await getProcessArgs(childPid, { timeoutMs: CMD_TIMEOUT });
    if (!args) return null;

    return cleanCommandLine(args);
  } catch {
    return null;
  }
};
