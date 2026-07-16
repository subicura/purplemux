import { describe, expect, it } from 'vitest';
import { answeredCustomAnswer, answeredLabels } from '@/lib/ask-question-answer';
import type { IAskUserQuestionItem, ITimelineAskUserQuestion } from '@/types/timeline';

const question = (header: string, text: string, labels: string[]): IAskUserQuestionItem => ({
  header,
  question: text,
  options: labels.map((label) => ({ label, description: '' })),
  multiSelect: false,
});

const entry = (
  questions: IAskUserQuestionItem[],
  answers: Record<string, string>,
): ITimelineAskUserQuestion => ({
  id: 'ask',
  type: 'ask-user-question',
  timestamp: 1,
  toolUseId: 'tool',
  questions,
  status: 'success',
  answers,
});

describe('AskUserQuestion answer display helpers', () => {
  it('matches answers keyed by question text', () => {
    const q = question('정렬 방식', '타임라인 항목의 기본 정렬 방식은 무엇으로 할까요?', ['최신순', '오래된순']);
    const e = entry([q], { '타임라인 항목의 기본 정렬 방식은 무엇으로 할까요?': '오래된순' });

    expect(answeredLabels(e, q, 0)).toEqual(['오래된순']);
    expect(answeredCustomAnswer(e, q, 0)).toBe('');
  });

  it('shows custom answers that are not option labels', () => {
    const q = question('표시 스타일', '질문 UI의 선택지 표시 스타일은 무엇으로 할까요?', ['카드형', '리스트형']);
    const e = entry([q], { '질문 UI의 선택지 표시 스타일은 무엇으로 할까요?': '라이브 직접 스타일' });

    expect(answeredLabels(e, q, 0)).toEqual(['라이브 직접 스타일']);
    expect(answeredCustomAnswer(e, q, 0)).toBe('라이브 직접 스타일');
  });

  it('falls back to answer order for legacy key mismatches', () => {
    const first = question('정렬 방식', '정렬 방식은?', ['최신순', '오래된순']);
    const second = question('표시 스타일', '표시 스타일은?', ['카드형', '리스트형']);
    const e = entry([first, second], {
      '첫 번째 질문': '오래된순',
      '두 번째 질문': '직접 스타일',
    });

    expect(answeredLabels(e, first, 0)).toEqual(['오래된순']);
    expect(answeredCustomAnswer(e, second, 1)).toBe('직접 스타일');
  });
});
