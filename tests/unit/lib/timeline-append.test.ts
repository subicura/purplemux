import { describe, expect, it } from 'vitest';
import { appendTimelineEntries } from '@/lib/timeline-append';
import type { ITimelineEntry } from '@/types/timeline';

describe('appendTimelineEntries', () => {
  it('copies AskUserQuestion answers from live tool results', () => {
    const existing: ITimelineEntry[] = [
      {
        id: 'ask-1',
        type: 'ask-user-question',
        timestamp: 1,
        toolUseId: 'tool-1',
        questions: [
          {
            header: '정렬 방식',
            question: '정렬 방식은?',
            options: [
              { label: '최신순', description: '' },
              { label: '오래된순', description: '' },
            ],
            multiSelect: false,
          },
          {
            header: '표시 스타일',
            question: '표시 스타일은?',
            options: [
              { label: '카드형', description: '' },
              { label: '리스트형', description: '' },
            ],
            multiSelect: false,
          },
        ],
        status: 'pending',
      },
    ];
    const resultEntry: ITimelineEntry = {
      id: 'result-1',
      type: 'tool-result',
      timestamp: 2,
      toolUseId: 'tool-1',
      isError: false,
      summary: '오래된순, 직접',
      answers: {
        '정렬 방식은?': '오래된순',
        '표시 스타일은?': '직접',
      },
    };

    const updated = appendTimelineEntries(existing, [resultEntry]);

    expect(updated[0]).toMatchObject({
      type: 'ask-user-question',
      status: 'success',
      answer: '오래된순, 직접',
      answers: {
        '정렬 방식은?': '오래된순',
        '표시 스타일은?': '직접',
      },
    });
    expect(updated[1]).toBe(resultEntry);
  });
});
