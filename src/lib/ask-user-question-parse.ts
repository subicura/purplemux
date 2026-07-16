import type { IAskUserQuestionItem } from '@/types/timeline';

const optionalBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

/** AskUserQuestion 도구 입력(tool_input)에서 질문 배열을 파싱한다. JSONL 파싱과 hook 수신에서 공용. */
export const parseAskUserQuestionInput = (input: unknown): IAskUserQuestionItem[] => {
  if (!input || typeof input !== 'object') return [];
  const questions = (input as Record<string, unknown>).questions;
  if (!Array.isArray(questions)) return [];
  return (questions as Record<string, unknown>[]).map((q) => {
    const allowCustomAnswer = optionalBoolean(q.allowCustomAnswer)
      ?? optionalBoolean(q.allowCustom)
      ?? optionalBoolean(q.allowOther)
      ?? optionalBoolean(q.allowFreeform)
      ?? optionalBoolean(q.allowFreeForm)
      ?? optionalBoolean(q.allowUserInput);

    return {
      question: String(q.question ?? ''),
      header: String(q.header ?? ''),
      options: Array.isArray(q.options)
        ? (q.options as Record<string, unknown>[]).map((o) => ({
            label: String(o.label ?? ''),
            description: String(o.description ?? ''),
          }))
        : [],
      multiSelect: Boolean(q.multiSelect),
      ...(allowCustomAnswer !== undefined ? { allowCustomAnswer } : {}),
    } satisfies IAskUserQuestionItem;
  });
};
