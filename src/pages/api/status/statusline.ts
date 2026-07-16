import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { verifyCliToken } from '@/lib/cli-token';
import { writeProviderRateLimits } from '@/lib/rate-limits-cache';
import { writeSessionStats, readSessionStats } from '@/lib/session-stats';
import { broadcastSessionStats } from '@/lib/timeline-server';
import { getStatusManager } from '@/lib/status-manager';
import { createLogger } from '@/lib/logger';
import type { ISessionStats } from '@/types/timeline';

const log = createLogger('statusline');

interface IClaudeStatusInput {
  session_id?: string;
  transcript_path?: string;
  model?: { id?: string; display_name?: string };
  workspace?: { project_dir?: string };
  rate_limits?: {
    five_hour?: { used_percentage: number; resets_at: number } | null;
    seven_day?: { used_percentage: number; resets_at: number } | null;
  };
  context_window?: {
    used_percentage?: number;
    remaining_percentage?: number;
    total_input_tokens?: number;
    total_output_tokens?: number;
    context_window_size?: number;
    current_usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens?: number;
    };
  };
  cost?: {
    total_cost_usd?: number;
    total_duration_ms?: number;
    total_duration_api_ms?: number;
  };
  exceeds_200k_tokens?: boolean;
}

const readUserStatusLineCommand = async (input: IClaudeStatusInput): Promise<string | null> => {
  const projectDir = input.workspace?.project_dir;
  const candidates: string[] = [];
  if (projectDir) {
    candidates.push(path.join(projectDir, '.claude', 'settings.local.json'));
    candidates.push(path.join(projectDir, '.claude', 'settings.json'));
  }
  candidates.push(path.join(os.homedir(), '.claude', 'settings.json'));

  for (const file of candidates) {
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const parsed = JSON.parse(raw);
      const cmd = parsed?.statusLine?.command;
      if (typeof cmd === 'string' && cmd.trim()) return cmd;
    } catch {
      // missing or invalid; try next
    }
  }
  return null;
};

const runUserCommand = (cmd: string, input: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', cmd], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 && stderr) {
        log.debug({ code, stderr }, 'user statusLine exited non-zero');
      }
      resolve(stdout);
    });
    child.stdin.write(input);
    child.stdin.end();
  });

const writeRateLimitsIfPresent = async (input: IClaudeStatusInput): Promise<void> => {
  const fiveHour = input.rate_limits?.five_hour ?? null;
  const sevenDay = input.rate_limits?.seven_day ?? null;
  if (!fiveHour && !sevenDay) return;

  const ts = Date.now() / 1000;
  const data = {
    ts,
    five_hour: fiveHour,
    seven_day: sevenDay,
  };

  try {
    await writeProviderRateLimits('claude', data);
  } catch (err) {
    log.debug({ err }, 'failed to write rate-limits.json');
  }
};

const buildSessionStats = (input: IClaudeStatusInput): ISessionStats | null => {
  const sessionId = input.session_id;
  if (!sessionId) return null;

  const ctx = input.context_window;
  const cu = ctx?.current_usage;
  const currentContextTokens = cu
    ? (cu.input_tokens ?? 0) +
      (cu.cache_creation_input_tokens ?? 0) +
      (cu.cache_read_input_tokens ?? 0)
    : 0;

  return {
    sessionId,
    transcriptPath: input.transcript_path,
    inputTokens: ctx?.total_input_tokens ?? 0,
    outputTokens: ctx?.total_output_tokens ?? 0,
    cost: input.cost?.total_cost_usd ?? null,
    currentContextTokens,
    contextWindowSize: ctx?.context_window_size ?? 0,
    usedPercentage: ctx?.used_percentage ?? null,
    model: input.model?.display_name ?? null,
    exceeds200k: input.exceeds_200k_tokens ?? false,
    receivedAt: Date.now(),
  };
};

const persistSessionStatsIfPresent = async (input: IClaudeStatusInput): Promise<void> => {
  const stats = buildSessionStats(input);
  if (!stats) return;
  await writeSessionStats(stats);
  const merged = (await readSessionStats(stats.sessionId)) ?? stats;
  try {
    broadcastSessionStats(merged);
  } catch (err) {
    log.debug({ err }, 'failed to broadcast session stats');
  }
};

const applyStatuslineMetaIfPresent = async (
  req: NextApiRequest,
  input: IClaudeStatusInput,
): Promise<void> => {
  const provider = typeof req.query.provider === 'string' && req.query.provider
    ? req.query.provider
    : 'claude';
  const tmuxSession = typeof req.query.tmuxSession === 'string'
    ? req.query.tmuxSession
    : '';
  if (!tmuxSession) return;
  if (!input.session_id && !input.transcript_path) return;

  await getStatusManager().applyProviderStatuslineMeta(provider, tmuxSession, {
    sessionId: input.session_id,
    jsonlPath: input.transcript_path,
  });
};

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!verifyCliToken(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const input = (req.body ?? {}) as IClaudeStatusInput;

  await Promise.all([
    writeRateLimitsIfPresent(input),
    persistSessionStatsIfPresent(input),
    applyStatuslineMetaIfPresent(req, input).catch((err) => {
      log.debug({ err }, 'failed to apply statusLine metadata');
    }),
  ]);

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');

  try {
    const userCmd = await readUserStatusLineCommand(input);
    if (userCmd) {
      const out = await runUserCommand(userCmd, JSON.stringify(input));
      return res.status(200).send(out);
    }
  } catch (err) {
    log.debug({ err }, 'user statusLine failed');
  }

  return res.status(204).end();
};

export default handler;
