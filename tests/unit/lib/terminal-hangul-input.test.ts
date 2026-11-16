import { describe, expect, it } from 'vitest';
import { createHangulInput } from '@/lib/terminal-hangul-input';

const setup = () => {
  const sent: string[] = [];
  let preview = '';
  const input = createHangulInput((text) => sent.push(text), (text) => { preview = text; });
  const edit = (value: string, data: string | null, inputType = 'insertReplacementText') =>
    input.handleInput({ data, inputType, isComposing: false }, value, value.length);
  return { input, edit, sent, preview: () => preview };
};

describe('Safari Hangul input', () => {
  it('sends completed syllables once instead of their initial jamo', () => {
    const { input, edit, sent, preview } = setup();
    edit('ㅎ', 'ㅎ', 'insertText');
    edit('하', '하');
    edit('한', '한');
    expect(sent).toEqual([]);
    expect(preview()).toBe('한');
    edit('한ㄱ', 'ㄱ', 'insertText');
    edit('한그', '그');
    edit('한글', '글');
    input.flush();
    input.flush();
    expect(sent).toEqual(['한', '글']);
    expect(preview()).toBe('');
  });

  it('commits the changed final consonant when it moves to the next syllable', () => {
    const { input, edit, sent } = setup();
    edit('ㅎ', 'ㅎ', 'insertText');
    edit('하', '하');
    edit('핫', '핫');
    edit('하', '하');
    edit('하세', '세', 'insertText');
    input.flush();
    expect(sent).toEqual(['하', '세']);
  });

  it('leaves standard IME composition and ordinary text to xterm', () => {
    const { input, edit, sent } = setup();
    expect(input.handleInput({ data: '한', inputType: 'insertCompositionText', isComposing: true }, '한', 1)).toBe(false);
    expect(edit('abc', 'abc', 'insertText')).toBe(false);
    expect(edit('🙂', '🙂', 'insertText')).toBe(false);
    expect(edit('韓', '韓', 'insertText')).toBe(false);
    input.flush();
    expect(sent).toEqual([]);
  });

  it('preserves a prefix and a suffix outside the composing range', () => {
    const { input, sent } = setup();
    input.handleInput({ data: 'ㅎ', inputType: 'insertText', isComposing: false }, 'abcㅎxyz', 4);
    input.handleInput({ data: '한', inputType: 'insertReplacementText', isComposing: false }, 'abc한xyz', 4);
    input.flush();
    expect(sent).toEqual(['한']);
  });

  it('keeps space and punctuation ordered after the pending syllable', () => {
    const { edit, sent } = setup();
    edit('한', '한', 'insertText');
    expect(edit('한 ', ' ', 'insertText')).toBe(true);
    expect(sent).toEqual(['한', ' ']);
    edit('한 글', '글', 'insertText');
    expect(edit('한 글.', '.', 'insertText')).toBe(true);
    expect(sent).toEqual(['한', ' ', '글', '.']);
  });

  it('does not send a syllable erased by Backspace', () => {
    const { input, edit, sent, preview } = setup();
    edit('한', '한', 'insertText');
    edit('하', null, 'deleteContentBackward');
    expect(preview()).toBe('하');
    edit('', null, 'deleteContentBackward');
    input.flush();
    expect(sent).toEqual([]);
    expect(preview()).toBe('');
  });

  it.each(['deletion', 'space'])('consumes the trailing IME key after %s empties the buffer', (boundary) => {
    const { input, edit } = setup();
    const key = { key: 'Process', keyCode: 229, isComposing: false, altKey: false, ctrlKey: false, metaKey: false };
    edit('ㅎ', 'ㅎ', 'insertText');
    input.handleKeyDown(key);
    if (boundary === 'deletion') edit('', null, 'deleteContentBackward');
    else edit('ㅎ ', ' ', 'insertText');
    // xterm must not schedule its own textarea-diff timer after this handled edit.
    expect(input.handleKeyDown(key)).toBe(true);
    expect(input.handleKeyDown(key)).toBe(false);
  });

  it('drops pending input when the terminal is disposed or reset', () => {
    const { input, edit, sent, preview } = setup();
    edit('한', '한', 'insertText');
    input.reset();
    input.flush();
    expect(sent).toEqual([]);
    expect(preview()).toBe('');
  });

  it('leaves Shift and IME keydowns inside the composition, then flushes before Enter', () => {
    const { input, edit, sent } = setup();
    const key = { key: 'Process', keyCode: 229, isComposing: false, altKey: false, ctrlKey: false, metaKey: false };
    edit('해', '해', 'insertText');
    expect(input.handleKeyDown(key)).toBe(true);
    expect(input.handleKeyDown({ ...key, key: 'Shift', keyCode: 16 })).toBe(false);
    expect(sent).toEqual([]);
    edit('했', '했');
    expect(input.handleKeyDown({ ...key, key: 'Enter', keyCode: 13 })).toBe(false);
    expect(sent).toEqual(['했']);
  });

  it('edits a pending syllable on Backspace but commits before word deletion or Ctrl+C', () => {
    const { input, edit, sent } = setup();
    const key = { key: 'Backspace', keyCode: 8, isComposing: false, altKey: false, ctrlKey: false, metaKey: false };
    edit('한', '한', 'insertText');
    expect(input.handleKeyDown(key)).toBe(true);
    expect(sent).toEqual([]);
    edit('하', '하');
    expect(input.handleKeyDown({ ...key, altKey: true })).toBe(false);
    expect(sent).toEqual(['하']);
    edit('하ㄱ', 'ㄱ', 'insertText');
    expect(input.handleKeyDown({ ...key, key: 'c', keyCode: 67, ctrlKey: true })).toBe(false);
    expect(sent).toEqual(['하', 'ㄱ']);
  });
});
