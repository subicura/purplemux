import type { IAskUserQuestionItem } from '@/types/timeline';

export type TAskSelections = Record<number, number[]>;
export type TAskCustomAnswers = Record<number, string>;
export type TAskInputStep = string | { type: 'literal'; value: string };

/**
 * AskUserQuestion 폼 선택을 터미널 키 시퀀스로 변환한다.
 * 가정: 진입 시 첫 질문·첫 옵션에 포커스가 있고, single은 Enter가 선택+다음 질문 이동,
 * multi는 Space 토글 후 Enter가 다음 질문으로 이동한다.
 *
 * 질문이 여러 개거나 멀티 선택이면 마지막에 "Submit answers" 확인 화면이 있어
 * Enter를 한 번 더 눌러야 제출된다. 반면 질문 1개 + 단일 선택은 확인 화면이 없어
 * (Claude Code가 `hideSubmitTab = questions.length===1 && !multiSelect`로 처리)
 * 옵션 Enter가 곧 제출이므로 추가 Enter를 붙이면 빈 입력이 새어 나간다.
 */
export const buildKeySequence = (
  questions: IAskUserQuestionItem[],
  selections: TAskSelections,
  customAnswers: TAskCustomAnswers = {},
): TAskInputStep[] => {
  const keys: TAskInputStep[] = [];
  questions.forEach((q, qIdx) => {
    const customAnswer = !q.multiSelect && customAnswers[qIdx]?.trim();
    if (customAnswer) {
      for (let k = 0; k < q.options.length; k += 1) keys.push('Down');
      keys.push({ type: 'literal', value: customAnswer });
      keys.push('Enter');
      return;
    }

    const selected = [...(selections[qIdx] ?? [])].sort((a, b) => a - b);
    if (q.multiSelect) {
      let pos = 0;
      for (const idx of selected) {
        for (let k = 0; k < idx - pos; k += 1) keys.push('Down');
        keys.push('Space');
        pos = idx;
      }
      keys.push('Enter');
    } else {
      const idx = selected[0] ?? 0;
      for (let k = 0; k < idx; k += 1) keys.push('Down');
      keys.push('Enter');
    }
  });
  const hasSubmitConfirm = !(questions.length === 1 && !questions[0]?.multiSelect);
  if (hasSubmitConfirm) keys.push('Enter');
  return keys;
};
