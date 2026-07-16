import fs from 'fs/promises';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { diffLines } from 'diff';
import type {
  ITimelineEntry,
  ITimelineUserMessage,
  ITimelineAssistantMessage,
  ITimelineThinking,
  ITimelineToolCall,
  ITimelineToolResult,
  ITimelineAgentGroup,
  ITimelineTaskNotification,
  ITimelineTaskProgress,
  ITimelinePlan,
  ITimelineAskUserQuestion,
  ITimelineInterrupt,
  ITimelineSessionExit,
  ITimelineTurnEnd,
  ITimelineDiff,
  IParseResult,
  IIncrementalResult,
  IChunkReadResult,
  TToolStatus,
} from '@/types/timeline';
import { parseAskUserQuestionInput } from '@/lib/ask-user-question-parse';

export const INTERRUPT_PREFIX = '[Request interrupted by user';

const countDiffLines = (oldStr: string, newStr: string): { added: number; removed: number } => {
  let added = 0;
  let removed = 0;
  for (const change of diffLines(oldStr, newStr)) {
    const count = change.count ?? 0;
    if (change.added) added += count;
    else if (change.removed) removed += count;
  }
  return { added, removed };
};

const EXCLUDED_TYPES = new Set([
  'progress', 'system', 'file-history-snapshot',
  'queue-operation', 'agent-name',
]);

const TAIL_THRESHOLD = 1_048_576; // 1MB

// --- Zod Schemas ---

const BaseEntrySchema = z.object({
  uuid: z.string().optional(),
  parentUuid: z.string().nullable().optional(),
  timestamp: z.string().optional(),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  isSidechain: z.boolean().optional(),
  type: z.string(),
  userType: z.literal('external').optional(),
  version: z.string().optional(),
  gitBranch: z.string().optional(),
});

const TextContentSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const ToolUseContentSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
});

const ThinkingContentSchema = z.object({
  type: z.literal('thinking'),
  thinking: z.string().optional(),
});

const ToolResultContentSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.unknown().optional(),
  is_error: z.boolean().optional(),
});

const AssistantContentSchema = z.discriminatedUnion('type', [
  TextContentSchema,
  ToolUseContentSchema,
  ThinkingContentSchema,
]);

const UserContentSchema = z.union([
  TextContentSchema,
  ToolResultContentSchema,
  z.object({ type: z.string() }).passthrough(),
]);

const AssistantEntrySchema = BaseEntrySchema.extend({
  type: z.literal('assistant'),
  message: z.object({
    role: z.literal('assistant').optional(),
    model: z.string().optional(),
    content: z.array(z.union([AssistantContentSchema, z.object({ type: z.string() }).passthrough()])),
    stop_reason: z.string().nullable().optional(),
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      cache_creation_input_tokens: z.number().optional(),
      cache_read_input_tokens: z.number().optional(),
      cache_creation: z.object({
        ephemeral_5m_input_tokens: z.number().optional(),
        ephemeral_1h_input_tokens: z.number().optional(),
      }).passthrough().optional(),
    }).passthrough().optional(),
  }),
});

const UserEntrySchema = BaseEntrySchema.extend({
  type: z.literal('user'),
  message: z.object({
    role: z.literal('user').optional(),
    content: z.union([
      z.string(),
      z.array(UserContentSchema),
    ]),
  }),
});

// --- Tool Summarization ---

export const summarizeToolCall = (name: string, input: Record<string, unknown> = {}): string => {
  switch (name) {
    case 'Read': {
      const fp = String(input.file_path ?? input.path ?? '');
      return `Read ${fp}`;
    }
    case 'Edit': {
      const fp = String(input.file_path ?? '');
      const oldStr = String(input.old_string ?? '');
      const newStr = String(input.new_string ?? '');
      const verb = oldStr ? 'Update' : 'Create';
      const { added, removed } = countDiffLines(oldStr, newStr);
      return `${verb} ${fp} (+${added}, -${removed})`;
    }
    case 'Write':
      return `Write ${String(input.file_path ?? '')}`;
    case 'Bash': {
      const cmd = String(input.command ?? '').split('\n')[0];
      return `$ ${cmd}`;
    }
    case 'Grep':
    case 'Glob': {
      const pattern = String(input.pattern ?? '');
      return `${name} "${pattern}"`;
    }
    default: {
      const firstKey = Object.keys(input)[0];
      const firstVal = firstKey ? String(input[firstKey]).slice(0, 60) : '';
      return `${name}${firstVal ? ` ${firstVal}` : ''}`;
    }
  }
};

export const summarizeToolResult = (content: string | unknown[], isError: boolean): string => {
  if (isError) return 'error';

  if (typeof content === 'string') {
    const lines = content.split('\n');
    return lines.length > 1 ? `${lines.length} lines` : lines[0].slice(0, 100);
  }

  if (Array.isArray(content)) {
    const textItems = content.filter(
      (item): item is { type: 'text'; text: string } =>
        typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'text',
    );
    if (textItems.length > 0) {
      const text = String(textItems[0].text ?? '');
      const lines = text.split('\n');
      return lines.length > 1 ? `${lines.length} lines` : lines[0].slice(0, 100);
    }
  }

  return '';
};

const PROTOCOL_TAGS = [
  'local-command-caveat',
  'local-command-stdout',
  'command-name',
  'command-message',
  'command-args',
  'user-prompt-submit-hook',
  'system-reminder',
];

const PROTOCOL_TAG_RE = new RegExp(
  `<(?:${PROTOCOL_TAGS.join('|')})[^>]*>[\\s\\S]*?</(?:${PROTOCOL_TAGS.join('|')})>`,
  'g',
);

const stripProtocolTags = (text: string): string => {
  return text.replace(PROTOCOL_TAG_RE, '').trim();
};

const COMMAND_NAME_RE = /<command-name>\s*(.*?)\s*<\/command-name>/;
const COMMAND_ARGS_RE = /<command-args>\s*(.*?)\s*<\/command-args>/;

const extractCommandName = (text: string): string | null => {
  const match = text.match(COMMAND_NAME_RE);
  if (!match) return null;
  const name = match[1];
  const argsMatch = text.match(COMMAND_ARGS_RE);
  return argsMatch ? `${name} ${argsMatch[1]}` : name;
};

// --- Task Notification Parsing ---

const TASK_NOTIFICATION_RE = /<task-notification>([\s\S]*?)<\/task-notification>/;

const extractTag = (xml: string, tag: string): string | undefined => {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`);
  const m = xml.match(re);
  return m ? m[1].trim() : undefined;
};

const parseTaskNotification = (text: string, timestamp: number): ITimelineTaskNotification | null => {
  const match = text.match(TASK_NOTIFICATION_RE);
  if (!match) return null;

  const xml = match[1];
  const taskId = extractTag(xml, 'task-id');
  const status = extractTag(xml, 'status');
  const summary = extractTag(xml, 'summary');
  if (!taskId || !status || !summary) return null;

  const result = extractTag(xml, 'result');
  const totalTokens = extractTag(xml, 'total_tokens');
  const toolUses = extractTag(xml, 'tool_uses');
  const durationMs = extractTag(xml, 'duration_ms');

  const usage = (totalTokens || toolUses || durationMs)
    ? {
      totalTokens: totalTokens ? Number(totalTokens) : undefined,
      toolUses: toolUses ? Number(toolUses) : undefined,
      durationMs: durationMs ? Number(durationMs) : undefined,
    }
    : undefined;

  return {
    id: nanoid(),
    type: 'task-notification',
    timestamp,
    taskId,
    status,
    summary,
    result,
    usage,
  };
};

// --- Internal Helpers ---

const extractDiff = (toolName: string, input: Record<string, unknown> = {}): { filePath?: string; diff?: ITimelineDiff } => {
  if (toolName === 'Edit') {
    const fp = String(input.file_path ?? '');
    const oldStr = String(input.old_string ?? '');
    const newStr = String(input.new_string ?? '');
    if (!oldStr && !newStr) return { filePath: fp };
    return { filePath: fp, diff: { filePath: fp, oldString: oldStr, newString: newStr } };
  }
  if (toolName === 'Write') {
    const fp = String(input.file_path ?? '');
    const content = String(input.content ?? '');
    if (!content) return { filePath: fp };
    return { filePath: fp, diff: { filePath: fp, oldString: '', newString: content } };
  }
  if (toolName === 'Read') {
    return { filePath: String(input.file_path ?? input.path ?? '') };
  }
  return {};
};

interface IRawEntry {
  base: z.infer<typeof BaseEntrySchema>;
  raw: unknown;
  lineOffset: number;
}

const parseSingleEntry = (raw: unknown, base: z.infer<typeof BaseEntrySchema>): ITimelineEntry[] => {
  const timestamp = base.timestamp ? new Date(base.timestamp).getTime() : Date.now();

  if (base.type === 'assistant') {
    const parsed = AssistantEntrySchema.safeParse(raw);
    if (!parsed.success) return [];

    const usage = parsed.data.message.usage;
    const model = parsed.data.message.model;
    let usageAttached = false;
    const entries: ITimelineEntry[] = [];
    for (const content of parsed.data.message.content) {
      if (content.type === 'thinking') {
        entries.push({
          id: nanoid(),
          type: 'thinking',
          timestamp,
          thinking: (content as { thinking?: string }).thinking ?? '',
        } satisfies ITimelineThinking);
      } else if (content.type === 'text' && 'text' in content) {
        const entry: ITimelineAssistantMessage = {
          id: nanoid(),
          type: 'assistant-message',
          timestamp,
          markdown: (content as { text: string }).text,
        };
        if (usage && !usageAttached) {
          entry.usage = usage;
          entry.model = model;
          usageAttached = true;
        }
        entries.push(entry);
      } else if (content.type === 'tool_use' && 'id' in content && 'name' in content) {
        const input = ('input' in content ? content.input : {}) as Record<string, unknown>;
        const toolName = (content as { name: string }).name;
        const toolUseId = (content as { id: string }).id;

        if (toolName === 'ExitPlanMode' && input.plan != null) {
          const planText = typeof input.plan === 'string' ? input.plan : JSON.stringify(input.plan, null, 2);
          entries.push({
            id: nanoid(),
            type: 'plan',
            timestamp,
            toolUseId,
            markdown: planText,
            filePath: typeof input.planFilePath === 'string' ? input.planFilePath : undefined,
            allowedPrompts: Array.isArray(input.allowedPrompts)
              ? (input.allowedPrompts as { tool?: string; prompt?: string }[]).map((p) => ({
                  tool: String(p.tool ?? ''),
                  prompt: String(p.prompt ?? ''),
                }))
              : undefined,
            status: 'pending' as TToolStatus,
          } satisfies ITimelinePlan);
        } else if (toolName === 'TaskCreate') {
          entries.push({
            id: nanoid(),
            type: 'task-progress',
            timestamp,
            action: 'create',
            taskId: '',
            toolUseId,
            subject: typeof input.subject === 'string' ? input.subject : '',
            description: typeof input.description === 'string' ? input.description : undefined,
            status: 'pending',
          } satisfies ITimelineTaskProgress);
        } else if (toolName === 'TaskUpdate') {
          const taskStatus = (['in_progress', 'completed', 'blocked'] as const).includes(input.status as 'in_progress' | 'completed' | 'blocked')
            ? (input.status as 'in_progress' | 'completed' | 'blocked')
            : 'pending';
          entries.push({
            id: nanoid(),
            type: 'task-progress',
            timestamp,
            action: 'update',
            taskId: typeof input.taskId === 'string' ? input.taskId : String(input.taskId ?? ''),
            status: taskStatus,
          } satisfies ITimelineTaskProgress);
        } else if (toolName === 'AskUserQuestion' && Array.isArray(input.questions)) {
          entries.push({
            id: nanoid(),
            type: 'ask-user-question',
            timestamp,
            toolUseId,
            questions: parseAskUserQuestionInput(input),
            status: 'pending' as TToolStatus,
          } satisfies ITimelineAskUserQuestion);
        } else {
          const summary = summarizeToolCall(toolName, input);
          const { filePath, diff } = extractDiff(toolName, input);

          entries.push({
            id: nanoid(),
            type: 'tool-call',
            timestamp,
            toolUseId,
            toolName,
            summary,
            filePath,
            diff,
            status: 'pending' as TToolStatus,
          } satisfies ITimelineToolCall);
        }
      }
    }

    const stopReason = parsed.data.message.stop_reason;
    if (stopReason !== undefined) {
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.type === 'assistant-message') {
          entry.stopReason = stopReason;
          break;
        }
      }
    }

    return entries;
  }

  if (base.type === 'user') {
    if ((raw as { isMeta?: boolean }).isMeta === true) return [];

    const parsed = UserEntrySchema.safeParse(raw);
    if (!parsed.success) return [];

    const entries: ITimelineEntry[] = [];
    const content = parsed.data.message.content;

    if (typeof content === 'string') {
      const taskNotif = parseTaskNotification(content, timestamp);
      if (taskNotif) return [taskNotif];

      const commandName = extractCommandName(content);
      if (commandName) {
        if (commandName === '/exit') {
          return [{
            id: nanoid(),
            type: 'session-exit',
            timestamp,
          } satisfies ITimelineSessionExit];
        }
        entries.push({
          id: nanoid(),
          type: 'user-message',
          timestamp,
          text: commandName,
        } satisfies ITimelineUserMessage);
        return entries;
      }
      const cleaned = stripProtocolTags(content);
      if (cleaned) {
        entries.push({
          id: nanoid(),
          type: 'user-message',
          timestamp,
          text: cleaned,
        } satisfies ITimelineUserMessage);
      }
      return entries;
    }

    if (
      content.length === 1 &&
      content[0].type === 'text' &&
      'text' in content[0] &&
      (content[0] as { text: string }).text.startsWith(INTERRUPT_PREFIX)
    ) {
      return [{
        id: nanoid(),
        type: 'interrupt',
        timestamp,
      } satisfies ITimelineInterrupt];
    }

    const userTextParts: string[] = [];
    const userImages: string[] = [];
    for (const item of content) {
      if (item.type === 'text' && 'text' in item) {
        const cleaned = stripProtocolTags((item as { text: string }).text);
        if (cleaned) userTextParts.push(cleaned);
      } else if (item.type === 'image' && 'source' in item) {
        const src = (item as { source?: { type?: string; media_type?: string; data?: string } }).source;
        if (src?.type === 'base64' && src.data) {
          userImages.push(`data:${src.media_type ?? 'image/png'};base64,${src.data}`);
        }
      }
    }
    if (userTextParts.length > 0 || userImages.length > 0) {
      entries.push({
        id: nanoid(),
        type: 'user-message',
        timestamp,
        text: userTextParts.join('\n'),
        ...(userImages.length > 0 ? { images: userImages } : {}),
      } satisfies ITimelineUserMessage);
    }

    for (const item of content) {
      if (item.type === 'tool_result' && 'tool_use_id' in item) {
        const c = item as { tool_use_id: string; is_error?: boolean; content?: unknown };

        const rawObj = raw as Record<string, unknown>;
        const toolUseResult = rawObj.toolUseResult as Record<string, unknown> | undefined;
        const answers = toolUseResult?.answers as Record<string, string> | undefined;

        const summaryText = answers
          ? Object.values(answers).join(', ')
          : summarizeToolResult(
          c.content as string | unknown[],
          c.is_error ?? false,
        );

        entries.push({
          id: nanoid(),
          type: 'tool-result',
          timestamp,
          toolUseId: c.tool_use_id,
          isError: c.is_error ?? false,
          summary: summaryText,
          ...(answers && { answers }),
        } satisfies ITimelineToolResult);
      }
    }
    return entries;
  }

  return [];
};

const createAgentGroup = (
  rawEntries: IRawEntry[],
  agentHint: { agentType: string; description: string } | null,
): ITimelineAgentGroup => {
  const first = rawEntries[0].base;
  const timestamp = first.timestamp ? new Date(first.timestamp).getTime() : Date.now();

  const parsed: ITimelineEntry[] = [];
  for (const { base, raw } of rawEntries) {
    parsed.push(...parseSingleEntry(raw, base));
  }
  const entries = mergeToolResults(parsed);

  if (agentHint) {
    return {
      id: nanoid(),
      type: 'agent-group',
      timestamp,
      agentType: agentHint.agentType,
      description: agentHint.description,
      entryCount: rawEntries.length,
      entries,
    };
  }

  let description = '';
  for (const { raw } of rawEntries) {
    const r = raw as Record<string, unknown>;
    if (r.type === 'user' && r.message) {
      const msg = r.message as Record<string, unknown>;
      const c = msg.content;
      if (typeof c === 'string') {
        description = c.slice(0, 100);
        break;
      }
      if (Array.isArray(c)) {
        for (const ci of c) {
          const item = ci as Record<string, unknown>;
          if (item.type === 'text' && typeof item.text === 'string') {
            description = item.text.slice(0, 100);
            break;
          }
        }
        if (description) break;
      }
    }
  }

  return {
    id: nanoid(),
    type: 'agent-group',
    timestamp,
    agentType: 'Unknown',
    description: description || 'Sub-agent',
    entryCount: rawEntries.length,
    entries,
  };
};

const mergeToolResults = (entries: ITimelineEntry[]): ITimelineEntry[] => {
  const toolCallMap = new Map<string, ITimelineToolCall>();
  const askQuestionMap = new Map<string, ITimelineAskUserQuestion>();
  const planMap = new Map<string, ITimelinePlan>();
  const taskCreateMap = new Map<string, ITimelineTaskProgress>();
  const result: ITimelineEntry[] = [];

  for (const entry of entries) {
    if (entry.type === 'tool-call') {
      toolCallMap.set(entry.toolUseId, entry);
      result.push(entry);
    } else if (entry.type === 'ask-user-question') {
      askQuestionMap.set(entry.toolUseId, entry);
      result.push(entry);
    } else if (entry.type === 'plan') {
      planMap.set(entry.toolUseId, entry);
      result.push(entry);
    } else if (entry.type === 'tool-result') {
      const status = entry.isError ? 'error' as const : 'success' as const;

      const pendingTask = taskCreateMap.get(entry.toolUseId);
      if (pendingTask && entry.summary) {
        const idMatch = entry.summary.match(/^Task #(\d+)/);
        if (idMatch) pendingTask.taskId = idMatch[1];
        taskCreateMap.delete(entry.toolUseId);
      }

      const toolCall = toolCallMap.get(entry.toolUseId);
      if (toolCall) {
        toolCall.status = status;

        if (entry.summary && !entry.isError) {
          const linesMatch = entry.summary.match(/^(\d+) lines$/);
          if (toolCall.toolName === 'Bash' && linesMatch) {
            toolCall.summary = `${toolCall.summary} → ${linesMatch[1]} lines`;
          } else if (toolCall.toolName === 'Grep' || toolCall.toolName === 'Glob') {
            const count = linesMatch ? linesMatch[1] : '1';
            toolCall.summary = `${toolCall.summary} → ${count} results`;
          }
        }
      } else {
        const askQuestion = askQuestionMap.get(entry.toolUseId);
        if (askQuestion) {
          askQuestion.status = status;
          if (entry.summary) {
            askQuestion.answer = entry.summary;
          }
          if (entry.answers) {
            askQuestion.answers = entry.answers;
          }
        } else {
          const plan = planMap.get(entry.toolUseId);
          if (plan) {
            plan.status = status;
          }
        }
      }

      result.push(entry);
    } else {
      if (entry.type === 'task-progress' && entry.action === 'create' && entry.toolUseId) {
        taskCreateMap.set(entry.toolUseId, entry);
      }
      result.push(entry);
    }
  }

  return result;
};

// --- Core Parsing ---

const parseContent = (content: string): IParseResult => {
  const splitLines = content.split('\n');
  const rawEntries: IRawEntry[] = [];
  let errorCount = 0;
  let sessionSummary: string | undefined;
  let customTitle: string | undefined;
  let lineCount = 0;

  let bytePos = 0;
  for (const rawLine of splitLines) {
    const lineByteOffset = bytePos;
    bytePos += Buffer.byteLength(rawLine, 'utf-8') + 1;
    if (!rawLine.trim()) continue;
    lineCount++;
    try {
      const raw = JSON.parse(rawLine);
      const base = BaseEntrySchema.safeParse(raw);
      if (!base.success) {
        errorCount++;
        continue;
      }
      if (!sessionSummary && base.data.type === 'user') {
        const userParsed = UserEntrySchema.safeParse(raw);
        if (userParsed.success) {
          const content = userParsed.data.message.content;
          if (typeof content === 'string') {
            const cleaned = stripProtocolTags(content);
            if (cleaned) sessionSummary = cleaned;
          } else if (Array.isArray(content)) {
            for (const item of content) {
              if (item.type === 'text' && 'text' in item) {
                const cleaned = stripProtocolTags((item as { text: string }).text);
                if (cleaned) { sessionSummary = cleaned; break; }
              }
            }
          }
        }
      }
      if (base.data.type === 'custom-title') {
        const rawObj = raw as Record<string, unknown>;
        const title = rawObj.title ?? rawObj.customTitle;
        if (typeof title === 'string' && title.trim()) {
          customTitle = title.trim();
        }
        continue;
      }
      if (base.data.type === 'summary') {
        const rawObj = raw as Record<string, unknown>;
        const summaryText = rawObj.summary ?? rawObj.text;
        if (typeof summaryText === 'string' && summaryText.trim() && !sessionSummary) {
          sessionSummary = summaryText.trim();
        }
        continue;
      }
      if (base.data.type === 'system') {
        const rawObj = raw as Record<string, unknown>;
        if (rawObj.subtype === 'stop_hook_summary' || rawObj.subtype === 'turn_duration') {
          rawEntries.push({ base: base.data, raw, lineOffset: lineByteOffset });
        }
        continue;
      }
      if (EXCLUDED_TYPES.has(base.data.type)) continue;
      rawEntries.push({ base: base.data, raw, lineOffset: lineByteOffset });
    } catch {
      errorCount++;
    }
  }

  const entries: ITimelineEntry[] = [];
  const entryLineOffsets: number[] = [];
  let lastAgentHint: { agentType: string; description: string } | null = null;
  let skipNextUser = false;
  let planFilePath: string | null = null;
  let i = 0;

  while (i < rawEntries.length) {
    const { base, raw, lineOffset } = rawEntries[i];

    if (base.type === 'attachment') {
      const rawObj = raw as Record<string, unknown>;
      const att = rawObj.attachment as Record<string, unknown> | undefined;
      if (att?.type === 'plan_mode' && typeof att.planFilePath === 'string') {
        planFilePath = att.planFilePath;
      }
      if (att?.type === 'plan_file_reference' && typeof att.planContent === 'string' && att.planContent.length > 0) {
        const timestamp = base.timestamp ? new Date(base.timestamp).getTime() : Date.now();
        entries.push({
          id: nanoid(),
          type: 'plan',
          timestamp,
          toolUseId: '',
          markdown: att.planContent,
          filePath: typeof att.planFilePath === 'string' ? att.planFilePath : undefined,
          status: 'success' as TToolStatus,
        } satisfies ITimelinePlan);
        entryLineOffsets.push(lineOffset);
        if (typeof att.planFilePath === 'string') planFilePath = att.planFilePath;
      }
    }

    if (base.type === 'system') {
      const timestamp = base.timestamp ? new Date(base.timestamp).getTime() : Date.now();
      entries.push({
        id: nanoid(),
        type: 'turn-end',
        timestamp,
      } satisfies ITimelineTurnEnd);
      entryLineOffsets.push(lineOffset);
      i++;
      continue;
    }

    if (base.isSidechain) {
      const group: IRawEntry[] = [];
      const groupOffset = rawEntries[i].lineOffset;
      while (i < rawEntries.length && rawEntries[i].base.isSidechain) {
        group.push(rawEntries[i]);
        i++;
      }
      entries.push(createAgentGroup(group, lastAgentHint));
      entryLineOffsets.push(groupOffset);
      lastAgentHint = null;
      continue;
    }

    if (base.type === 'user' && skipNextUser) {
      skipNextUser = false;
      i++;
      continue;
    }

    const parsed = parseSingleEntry(raw, base);

    for (const entry of parsed) {
      if (entry.type === 'user-message' && entry.text.startsWith('/')) {
        skipNextUser = true;
      }
      if (entry.type === 'tool-call' && entry.toolName === 'Agent') {
        const assistantParsed = AssistantEntrySchema.safeParse(raw);
        if (assistantParsed.success) {
          for (const c of assistantParsed.data.message.content) {
            if (c.type === 'tool_use' && 'name' in c && (c as { name: string }).name === 'Agent') {
              const input = ('input' in c ? c.input : {}) as Record<string, unknown>;
              lastAgentHint = {
                agentType: String(input.subagent_type ?? input.type ?? 'Agent'),
                description: String(input.description ?? input.prompt ?? '').slice(0, 100),
              };
            }
          }
        }
      }
    }

    for (const entry of parsed) {
      entries.push(entry);
      entryLineOffsets.push(lineOffset);
    }
    i++;
  }

  if (planFilePath && !entries.some((e) => e.type === 'plan')) {
    for (let j = entries.length - 1; j >= 0; j--) {
      const e = entries[j];
      if (e.type === 'tool-call' && e.toolName === 'Write' && e.filePath === planFilePath && e.diff?.newString) {
        entries[j] = {
          id: e.id,
          type: 'plan',
          timestamp: e.timestamp,
          toolUseId: e.toolUseId,
          markdown: e.diff.newString,
          filePath: planFilePath,
          status: e.status,
        } satisfies ITimelinePlan;
        break;
      }
    }
  }

  return {
    entries: mergeToolResults(entries),
    entryLineOffsets,
    lastOffset: Buffer.byteLength(content, 'utf-8'),
    totalLines: lineCount,
    errorCount,
    summary: sessionSummary,
    customTitle,
  };
};

// --- Exported Functions ---

export const parseSessionFile = async (filePath: string): Promise<IParseResult> => {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size === 0) {
      return { entries: [], entryLineOffsets: [], lastOffset: 0, totalLines: 0, errorCount: 0 };
    }

    if (stat.size > TAIL_THRESHOLD) {
      return parseTailMode(filePath, stat.size);
    }

    const content = await fs.readFile(filePath, 'utf-8');
    return parseContent(content);
  } catch {
    return { entries: [], entryLineOffsets: [], lastOffset: 0, totalLines: 0, errorCount: 0 };
  }
};

const parseTailMode = async (filePath: string, fileSize: number): Promise<IParseResult> => {
  const readSize = Math.min(fileSize, 512_000);
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(readSize);
    const offset = fileSize - readSize;
    await handle.read(buffer, 0, readSize, offset);

    const content = buffer.toString('utf-8');
    const firstNewline = content.indexOf('\n');
    const validContent = firstNewline >= 0 ? content.slice(firstNewline + 1) : content;

    const result = parseContent(validContent);
    result.lastOffset = fileSize;
    return result;
  } finally {
    await handle.close();
  }
};

const CHUNK_SIZE = 256_000; // 256KB
const SMALL_FILE_THRESHOLD = CHUNK_SIZE;

const readChunk = async (
  filePath: string, from: number, to: number,
): Promise<{ content: string; validFrom: number }> => {
  const readSize = to - from;
  if (readSize <= 0) return { content: '', validFrom: from };
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(readSize);
    await handle.read(buffer, 0, readSize, from);
    const raw = buffer.toString('utf-8');
    if (from === 0) return { content: raw, validFrom: 0 };
    const firstNewline = raw.indexOf('\n');
    if (firstNewline < 0) return { content: '', validFrom: to };
    const validFrom = from + Buffer.byteLength(raw.slice(0, firstNewline + 1), 'utf-8');
    return { content: raw.slice(firstNewline + 1), validFrom };
  } finally {
    await handle.close();
  }
};

export const readTailEntries = async (
  filePath: string, maxEntries: number,
): Promise<IChunkReadResult> => {
  const empty: IChunkReadResult = {
    entries: [], startByteOffset: 0, fileSize: 0, hasMore: false, errorCount: 0,
  };
  try {
    const stat = await fs.stat(filePath);
    const fileSize = stat.size;
    if (fileSize === 0) return empty;

    if (fileSize <= SMALL_FILE_THRESHOLD) {
      const content = await fs.readFile(filePath, 'utf-8');
      const result = parseContent(content);
      const sliced = result.entries.length > maxEntries;
      const sliceStart = sliced ? result.entries.length - maxEntries : 0;
      const entries = sliced ? result.entries.slice(-maxEntries) : result.entries;
      return {
        entries,
        startByteOffset: sliced ? result.entryLineOffsets[sliceStart] : 0,
        fileSize,
        hasMore: sliced,
        errorCount: result.errorCount,
        summary: result.summary,
        customTitle: result.customTitle,
      };
    }

    let chunkSize = CHUNK_SIZE;
    while (chunkSize < fileSize * 2) {
      const from = Math.max(0, fileSize - chunkSize);
      const { content, validFrom } = await readChunk(filePath, from, fileSize);
      if (!content) { chunkSize *= 2; continue; }
      const result = parseContent(content);
      if (result.entries.length >= maxEntries || from === 0) {
        const sliced = result.entries.length > maxEntries;
        const sliceStart = sliced ? result.entries.length - maxEntries : 0;
        const entries = sliced ? result.entries.slice(-maxEntries) : result.entries;
        const startByteOffset = sliced
          ? validFrom + result.entryLineOffsets[sliceStart]
          : (from === 0 ? 0 : validFrom);
        return {
          entries,
          startByteOffset,
          fileSize,
          hasMore: startByteOffset > 0,
          errorCount: result.errorCount,
          summary: result.summary,
          customTitle: result.customTitle,
        };
      }
      chunkSize *= 2;
    }

    return empty;
  } catch {
    return empty;
  }
};

export const readEntriesBefore = async (
  filePath: string, beforeByte: number, maxEntries: number,
): Promise<IChunkReadResult> => {
  const empty: IChunkReadResult = {
    entries: [], startByteOffset: 0, fileSize: 0, hasMore: false, errorCount: 0,
  };
  try {
    if (beforeByte <= 0) return empty;
    const stat = await fs.stat(filePath);

    let chunkSize = CHUNK_SIZE;
    while (true) {
      const from = Math.max(0, beforeByte - chunkSize);
      const { content, validFrom } = await readChunk(filePath, from, beforeByte);
      if (content) {
        const result = parseContent(content);
        if (result.entries.length >= maxEntries || from === 0) {
          const sliced = result.entries.length > maxEntries;
          const sliceStart = sliced ? result.entries.length - maxEntries : 0;
          const entries = sliced ? result.entries.slice(-maxEntries) : result.entries;
          const startByteOffset = sliced
            ? validFrom + result.entryLineOffsets[sliceStart]
            : (from === 0 ? 0 : validFrom);
          return {
            entries,
            startByteOffset,
            fileSize: stat.size,
            hasMore: startByteOffset > 0,
            errorCount: result.errorCount,
          };
        }
      }
      if (from === 0) return empty;
      chunkSize *= 2;
    }
  } catch {
    return empty;
  }
};

export const parseIncremental = async (
  filePath: string,
  fromOffset: number,
  pendingBuffer: string = '',
): Promise<IIncrementalResult> => {
  try {
    const handle = await fs.open(filePath, 'r');
    const stat = await handle.stat();
    const size = stat.size;

    if (size < fromOffset) {
      await handle.close();
      const content = await fs.readFile(filePath, 'utf-8');
      const result = parseContent(content);
      return { newEntries: result.entries, newOffset: size, pendingBuffer: '' };
    }

    if (fromOffset >= size) {
      await handle.close();
      return { newEntries: [], newOffset: fromOffset, pendingBuffer };
    }

    const buffer = Buffer.alloc(size - fromOffset);
    await handle.read(buffer, 0, buffer.length, fromOffset);
    await handle.close();

    const rawContent = pendingBuffer + buffer.toString('utf-8');
    const endsWithNewline = rawContent.endsWith('\n');
    const segments = rawContent.split('\n');
    let newPending = '';
    if (!endsWithNewline) {
      const lastSegment = segments.pop() ?? '';
      if (lastSegment) {
        try {
          JSON.parse(lastSegment);
          segments.push(lastSegment);
        } catch {
          newPending = lastSegment;
        }
      }
    }
    const completeContent = segments.join('\n');
    const result = parseContent(completeContent);

    return {
      newEntries: result.entries,
      newOffset: size,
      pendingBuffer: newPending,
    };
  } catch {
    return { newEntries: [], newOffset: fromOffset, pendingBuffer };
  }
};

// Backwards-compatible wrappers

export const parseJsonlFile = async (filePath: string): Promise<ITimelineEntry[]> => {
  const result = await parseSessionFile(filePath);
  return result.entries;
};

export const parseJsonlIncremental = async (
  filePath: string,
  fromOffset: number,
): Promise<{ entries: ITimelineEntry[]; newOffset: number }> => {
  const result = await parseIncremental(filePath, fromOffset);
  return { entries: result.newEntries, newOffset: result.newOffset };
};

export const parseJsonlContent = (content: string): ITimelineEntry[] => {
  return parseContent(content).entries;
};

export const countJsonlEntries = async (filePath: string): Promise<number> => {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content.split('\n').filter((line) => line.trim()).length;
  } catch {
    return 0;
  }
};
