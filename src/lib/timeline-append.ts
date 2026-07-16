import type { ITimelineAskUserQuestion, ITimelineEntry, ITimelineToolCall } from '@/types/timeline';

const normalizeUserMessageText = (s: string) => s.replace(/\s+/g, ' ').trim();

export const appendTimelineEntries = (
  prev: ITimelineEntry[],
  newEntries: ITimelineEntry[],
): ITimelineEntry[] => {
  const updated = [...prev];
  for (const entry of newEntries) {
    if (entry.type === 'user-message') {
      const target = normalizeUserMessageText(entry.text);
      const pendingIdx = updated.findIndex(
        (e) => e.type === 'user-message' && e.pending && (e.attachmentPlaceholder || normalizeUserMessageText(e.text) === target),
      );
      if (pendingIdx !== -1) {
        const pending = updated[pendingIdx] as ITimelineEntry & { type: 'user-message' };
        updated[pendingIdx] = { ...entry, id: pending.id };
        continue;
      }
    }
    if (entry.type === 'tool-result') {
      const status = entry.isError ? 'error' as const : 'success' as const;
      const tcIdx = updated.findIndex(
        (e) => e.type === 'tool-call' && e.toolUseId === entry.toolUseId,
      );
      if (tcIdx !== -1) {
        const tc = updated[tcIdx] as ITimelineToolCall;
        updated[tcIdx] = { ...tc, status };
      } else {
        const aqIdx = updated.findIndex(
          (e) => e.type === 'ask-user-question' && e.toolUseId === entry.toolUseId,
        );
        if (aqIdx !== -1) {
          const aq = updated[aqIdx] as ITimelineAskUserQuestion;
          updated[aqIdx] = {
            ...aq,
            status,
            answer: entry.summary || undefined,
            ...(entry.answers ? { answers: entry.answers } : {}),
          };
        }
      }
    }
    updated.push(entry);
  }
  return updated;
};
