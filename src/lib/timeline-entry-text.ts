import type { ITimelineEntry } from '@/types/timeline';

/** 타임라인 항목에서 검색 대상 텍스트를 추출한다. */
export const getEntryText = (entry: ITimelineEntry): string => {
  const parts: (string | undefined)[] = [];
  switch (entry.type) {
    case 'user-message':
      parts.push(entry.text);
      break;
    case 'assistant-message':
      parts.push(entry.markdown);
      break;
    case 'thinking':
      parts.push(entry.thinking);
      break;
    case 'tool-call':
      parts.push(entry.toolName, entry.summary, entry.filePath);
      break;
    case 'tool-result':
      parts.push(entry.summary);
      break;
    case 'agent-group':
      parts.push(entry.agentType, entry.description);
      break;
    case 'task-notification':
      parts.push(entry.summary, entry.result);
      break;
    case 'task-progress':
      parts.push(entry.subject, entry.description);
      break;
    case 'plan':
      parts.push(entry.markdown);
      break;
    case 'ask-user-question':
      for (const q of entry.questions) {
        parts.push(q.header, q.question);
        for (const o of q.options) parts.push(o.label, o.description);
      }
      break;
    case 'approval-request':
      parts.push(entry.command, entry.cwd);
      break;
    case 'exec-command-stream':
      parts.push(entry.command, entry.parsedCommand, entry.stdout, entry.stderr);
      break;
    case 'web-search':
      parts.push(entry.query, entry.resultsSummary);
      break;
    case 'mcp-tool-call':
      parts.push(entry.server, entry.tool, entry.argumentsSummary, entry.resultSummary);
      break;
    case 'patch-apply':
      parts.push(...entry.files.map((f) => f.path), entry.diff);
      break;
    case 'reasoning-summary':
      parts.push(...entry.summary);
      break;
    case 'error-notice':
      parts.push(entry.message, entry.retryStatus, entry.errorCode);
      break;
    default:
      break;
  }
  return parts.filter(Boolean).join(' ');
};
