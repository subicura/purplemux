import { describe, expect, it } from 'vitest';

import { parseAskUserQuestionInput } from '@/lib/ask-user-question-parse';

describe('parseAskUserQuestionInput', () => {
  it('questions/options/description/multiSelect를 파싱한다', () => {
    const input = {
      questions: [
        {
          header: '민감도',
          question: '민감 정보가 있나요?',
          multiSelect: false,
          allowCustomAnswer: true,
          options: [
            { label: '로컬 필수', description: '기기 밖으로 안 나감' },
            { label: '클라우드 무방', description: '외부 전송 허용' },
          ],
        },
        {
          header: '규모',
          question: '문서 규모는?',
          multiSelect: true,
          options: [{ label: '소규모', description: '' }],
        },
      ],
    };
    const r = parseAskUserQuestionInput(input);
    expect(r).toHaveLength(2);
    expect(r[0].header).toBe('민감도');
    expect(r[0].multiSelect).toBe(false);
    expect(r[0].allowCustomAnswer).toBe(true);
    expect(r[0].options[0]).toEqual({ label: '로컬 필수', description: '기기 밖으로 안 나감' });
    expect(r[1].multiSelect).toBe(true);
  });

  it('questions가 없거나 배열이 아니면 빈 배열', () => {
    expect(parseAskUserQuestionInput({})).toEqual([]);
    expect(parseAskUserQuestionInput(null)).toEqual([]);
    expect(parseAskUserQuestionInput('nope')).toEqual([]);
    expect(parseAskUserQuestionInput({ questions: 'x' })).toEqual([]);
  });

  it('누락 필드는 기본값으로 채운다', () => {
    const r = parseAskUserQuestionInput({ questions: [{}] });
    expect(r[0]).toEqual({ question: '', header: '', options: [], multiSelect: false });
  });
});
