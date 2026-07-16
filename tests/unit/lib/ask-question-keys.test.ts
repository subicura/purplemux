import { describe, expect, it } from 'vitest';

import { buildKeySequence } from '@/lib/ask-question-keys';
import type { IAskUserQuestionItem } from '@/types/timeline';

const q = (header: string, optionCount: number, multiSelect = false): IAskUserQuestionItem => ({
  header,
  question: header,
  multiSelect,
  options: Array.from({ length: optionCount }, (_, i) => ({ label: `opt${i}`, description: '' })),
});

// 질문 1개 + 단일 선택은 "Submit answers" 확인 화면이 없어 옵션 Enter가 곧 제출이다.
// 그 외(멀티 질문 또는 멀티 선택)만 확인 화면 확정용 Enter가 붙는다.
describe('buildKeySequence', () => {
  it('단일 질문·단일 선택은 옵션 Enter로 끝(추가 제출 Enter 없음)', () => {
    expect(buildKeySequence([q('A', 3)], { 0: [1] })).toEqual(['Down', 'Enter']);
  });

  it('단일 질문·단일 선택 첫 옵션은 Down 없이 Enter만', () => {
    expect(buildKeySequence([q('A', 3)], { 0: [0] })).toEqual(['Enter']);
  });

  it('다중 질문은 각 질문을 Enter로 넘기고 끝에 제출 Enter', () => {
    const keys = buildKeySequence([q('A', 3), q('B', 3), q('C', 3)], { 0: [0], 1: [2], 2: [1] });
    expect(keys).toEqual(['Enter', 'Down', 'Down', 'Enter', 'Down', 'Enter', 'Enter']);
  });

  it('단일 질문이라도 멀티 선택이면 제출 Enter가 붙는다', () => {
    const keys = buildKeySequence([q('M', 4, true)], { 0: [0, 2] });
    expect(keys).toEqual(['Space', 'Down', 'Down', 'Space', 'Enter', 'Enter']);
  });

  it('multi-select 선택은 정렬되어 상대 이동만 발생', () => {
    const keys = buildKeySequence([q('M', 4, true)], { 0: [3, 1] });
    expect(keys).toEqual(['Down', 'Space', 'Down', 'Down', 'Space', 'Enter', 'Enter']);
  });

  it('단일 질문·단일 선택 미선택은 첫 옵션(Enter)만', () => {
    expect(buildKeySequence([q('A', 3)], {})).toEqual(['Enter']);
  });

  it('단일 질문 직접 입력은 마지막 옵션 선택 후 텍스트를 입력한다', () => {
    expect(buildKeySequence([q('A', 2)], { 0: [2] }, { 0: '직접 쓴 답' })).toEqual([
      'Down',
      'Down',
      { type: 'literal', value: '직접 쓴 답' },
      'Enter',
    ]);
  });

  it('다중 질문의 직접 입력은 마지막 제출 Enter를 유지한다', () => {
    expect(buildKeySequence([q('A', 2), q('B', 2)], { 0: [0], 1: [2] }, { 1: 'custom' })).toEqual([
      'Enter',
      'Down',
      'Down',
      { type: 'literal', value: 'custom' },
      'Enter',
      'Enter',
    ]);
  });
});
