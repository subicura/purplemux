import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyCliToken } from '@/lib/cli-token';
import { getStatusManager } from '@/lib/status-manager';
import { createLogger } from '@/lib/logger';
import { isRequestAllowed } from '@/lib/access-filter';
import { translateClaudeHookEvent } from '@/lib/providers/claude/hook-handler';
import { processCodexHookPayload, shouldEmitCodexHookEvent } from '@/lib/providers/codex/hook-handler';
import { codexHookEvents } from '@/lib/providers/codex/hook-events';
import { parseAskUserQuestionInput } from '@/lib/ask-user-question-parse';

const log = createLogger('hooks');

const handleClaudeHook = (req: NextApiRequest, res: NextApiResponse) => {
  const { event, session, notificationType } = req.body ?? {};
  if (typeof event === 'string' && event !== 'poll' && typeof session === 'string' && session) {
    const type = typeof notificationType === 'string' && notificationType ? notificationType : undefined;
    log.debug({ event, session, notificationType: type }, `received ${event}${type ? `(${type})` : ''}`);
    const workEvent = translateClaudeHookEvent(event, type);
    if (workEvent) {
      getStatusManager().handleProviderEvent('claude', session, workEvent);
    } else {
      log.debug({ event, session, notificationType: type }, 'unknown claude hook event, ignoring');
    }
  } else {
    log.debug({ body: req.body }, 'poll trigger');
    getStatusManager().poll().catch((err) => {
      log.error({ err }, 'Poll trigger failed');
    });
  }
  return res.status(204).end();
};

const handleClaudePreToolUse = (req: NextApiRequest, res: NextApiResponse) => {
  const session = typeof req.query.session === 'string' ? req.query.session : '';
  const body = (req.body ?? {}) as { tool_name?: unknown; tool_input?: unknown };
  if (session && body.tool_name === 'AskUserQuestion') {
    const items = parseAskUserQuestionInput(body.tool_input);
    log.debug({ session, count: items.length }, 'pre-tool-use AskUserQuestion');
    if (items.length > 0) {
      const manager = getStatusManager();
      manager.applyAgentHookMeta('claude', session, { askUserQuestionItems: items });
      manager.handleProviderEvent('claude', session, { kind: 'notification', notificationType: 'permission_prompt' });
    }
  }
  return res.status(204).end();
};

const handleClaudePostToolUse = (req: NextApiRequest, res: NextApiResponse) => {
  const session = typeof req.query.session === 'string' ? req.query.session : '';
  const body = (req.body ?? {}) as { tool_name?: unknown };
  if (session && body.tool_name === 'AskUserQuestion') {
    log.debug({ session }, 'post-tool-use AskUserQuestion, clearing pending questions and resuming');
    const manager = getStatusManager();
    manager.applyAgentHookMeta('claude', session, { askUserQuestionItems: null });
    // 답변 제출 후 Claude가 처리 중이므로 busy로 전환해 needs-input을 해제한다.
    // (needs-input이 남으면 permission 카드가 폴백으로 떠서 "옵션 로드/실패" 메시지가 노출됨)
    manager.handleProviderEvent('claude', session, { kind: 'prompt-submit' });
  }
  return res.status(204).end();
};

const handleCodexHook = (req: NextApiRequest, res: NextApiResponse) => {
  const tmuxSession = req.query.tmuxSession;
  if (typeof tmuxSession !== 'string' || !tmuxSession) {
    log.warn({ event: req.body?.hook_event_name }, 'codex hook missing tmuxSession');
    return res.status(400).json({ error: 'missing tmuxSession' });
  }
  const payload = req.body ?? {};
  log.debug(
    { tmuxSession, event: payload.hook_event_name, source: payload.source },
    `codex ${payload.hook_event_name ?? 'unknown'}`,
  );
  const statusManager = getStatusManager();
  const { result, translation } = processCodexHookPayload(payload);
  const applied = translation.meta
    ? statusManager.applyAgentHookMeta('codex', tmuxSession, translation.meta)
    : null;
  if (!applied) {
    log.debug({ tmuxSession, event: payload.hook_event_name, reason: 'unknown-session' }, 'codex hook skipped');
    return res.status(204).end();
  }
  if (translation.sessionInfo) {
    codexHookEvents.emit('session-info', tmuxSession, translation.sessionInfo);
    if (translation.clearSession) codexHookEvents.emit('session-clear', tmuxSession);
  }
  if (!result.ok) {
    log.debug({ tmuxSession, event: payload.hook_event_name, reason: result.reason }, 'codex hook skipped');
  }
  if (translation.event && shouldEmitCodexHookEvent(payload, applied.cliState)) {
    statusManager.handleProviderEvent('codex', tmuxSession, translation.event);
  }
  return res.status(204).end();
};

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!verifyCliToken(req)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (!isRequestAllowed(req.socket.remoteAddress)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  const provider = typeof req.query.provider === 'string' ? req.query.provider : 'claude';
  if (provider === 'codex') return handleCodexHook(req, res);
  if (req.query.event === 'pre-tool-use') return handleClaudePreToolUse(req, res);
  if (req.query.event === 'post-tool-use') return handleClaudePostToolUse(req, res);
  return handleClaudeHook(req, res);
};

export default handler;
