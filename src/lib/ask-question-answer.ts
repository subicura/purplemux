import type { IAskUserQuestionItem, ITimelineAskUserQuestion } from '@/types/timeline';

export const answerForQuestion = (
  entry: ITimelineAskUserQuestion,
  question: IAskUserQuestionItem,
  qIdx: number,
): string | undefined => {
  const answers = entry.answers;
  if (!answers) return entry.questions.length === 1 ? entry.answer : undefined;
  const direct = answers[question.header] ?? answers[question.question];
  if (direct !== undefined) return direct;

  const normalizedHeader = question.header.trim();
  const normalizedQuestion = question.question.trim();
  for (const [key, value] of Object.entries(answers)) {
    const normalizedKey = key.trim();
    if (normalizedKey === normalizedHeader || normalizedKey === normalizedQuestion) return value;
  }

  return Object.values(answers)[qIdx];
};

export const answeredLabels = (
  entry: ITimelineAskUserQuestion,
  question: IAskUserQuestionItem,
  qIdx: number,
): string[] => {
  const raw = answerForQuestion(entry, question, qIdx);
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim());
};

export const answeredCustomAnswer = (
  entry: ITimelineAskUserQuestion,
  question: IAskUserQuestionItem,
  qIdx: number,
): string => {
  if (question.multiSelect) return '';
  const raw = answerForQuestion(entry, question, qIdx);
  const answer = raw?.trim();
  if (!answer) return '';
  const optionLabels = new Set(question.options.map((option) => option.label));
  return optionLabels.has(answer) ? '' : answer;
};
