import type { Terminal } from '@xterm/xterm';

type TInput = Pick<InputEvent, 'data' | 'inputType' | 'isComposing'>;
type TKey = Pick<KeyboardEvent, 'key' | 'keyCode' | 'isComposing' | 'altKey' | 'ctrlKey' | 'metaKey'>;

// Safari edits Hangul in place without composition events (xterm.js #6284).
export const createHangulInput = (send: (text: string) => void, preview: (text: string) => void) => {
  let pending: { start: number; text: string } | null = null;
  let handledInput = false;

  const reset = () => {
    pending = null;
    handledInput = false;
    preview('');
  };

  const flush = () => {
    const text = pending?.text;
    reset();
    if (text) send(text);
  };

  const handleInput = (event: TInput, value: string, end: number): boolean => {
    if (event.isComposing) return false;
    if (event.inputType === 'insertText' && event.data) {
      const hadPending = pending !== null;
      flush();
      if (!/^\p{Script=Hangul}+$/u.test(event.data)) {
        if (hadPending) send(event.data);
        handledInput = hadPending;
        return hadPending;
      }
      pending = { start: Math.max(0, end - event.data.length), text: event.data };
    } else if (!pending || !['insertReplacementText', 'deleteContentBackward'].includes(event.inputType)) {
      return false;
    }

    pending.text = value.slice(pending.start, end);
    if (!pending.text) reset();
    else preview(pending.text);
    handledInput = true;
    return true;
  };

  const handleKeyDown = (event: TKey): boolean => {
    // Safari delivers 229 after the edit, even when it just emptied the buffer.
    if (event.keyCode === 229 && handledInput) {
      handledInput = false;
      return true;
    }
    handledInput = false;
    if (!pending) return false;
    if (event.isComposing || event.keyCode === 229) return true;
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(event.key)) return false;
    // Let the browser edit the pending syllable instead of deleting terminal output.
    if (event.key === 'Backspace' && !event.altKey && !event.ctrlKey && !event.metaKey) return true;
    flush();
    return false;
  };

  return { handleInput, handleKeyDown, flush, reset };
};

export const attachTerminalHangulInput = (terminal: Terminal) => {
  const element = terminal.element;
  const textarea = terminal.textarea;
  const screen = element?.querySelector<HTMLElement>('.xterm-screen');
  const helpers = element?.querySelector<HTMLElement>('.xterm-helpers');
  const userAgent = element?.ownerDocument.defaultView?.navigator.userAgent ?? '';
  const isWebKit = /AppleWebKit\//.test(userAgent) && !/(Chrome|Chromium|Edg|OPR)\//.test(userAgent);
  if (!isWebKit || !element || !textarea || !screen || !helpers) {
    return { reset: () => {}, dispose: () => {} };
  }

  const view = element.ownerDocument.createElement('div');
  view.className = 'composition-view';
  view.setAttribute('aria-hidden', 'true');
  view.style.pointerEvents = 'none';
  helpers.appendChild(view);

  const positionPreview = () => {
    if (!view.textContent) return;
    const buffer = terminal.buffer.active;
    const row = buffer.baseY + buffer.cursorY - buffer.viewportY;
    view.classList.toggle('active', row >= 0 && row < terminal.rows);
    const cellHeight = screen.clientHeight / terminal.rows;
    Object.assign(view.style, {
      left: `${Math.min(buffer.cursorX, terminal.cols - 1) * screen.clientWidth / terminal.cols}px`,
      top: `${row * cellHeight}px`,
      height: `${cellHeight}px`,
      lineHeight: `${cellHeight}px`,
      fontFamily: terminal.options.fontFamily,
      fontSize: `${terminal.options.fontSize}px`,
      color: terminal.options.theme?.foreground ?? '#fff',
      backgroundColor: terminal.options.theme?.background ?? '#000',
    });
  };

  const input = createHangulInput((text) => terminal.input(text, true), (text) => {
    if (text && terminal.options.scrollOnUserInput) terminal.scrollToBottom();
    view.textContent = text;
    view.classList.toggle('active', !!text);
    positionPreview();
  });
  let nativeComposing = false;
  let nativeSettling = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;

  const onInput = (event: Event) => {
    if (event.target !== textarea || nativeComposing || nativeSettling) return;
    if (input.handleInput(event as InputEvent, textarea.value, textarea.selectionEnd)) {
      event.stopImmediatePropagation();
    }
  };
  const onKeyDown = (event: Event) => {
    if (event.target === textarea && input.handleKeyDown(event as KeyboardEvent)) {
      // Keep the native edit; only stop xterm's textarea-diff timer and key handling.
      event.stopImmediatePropagation();
    }
  };
  const onCompositionStart = (event: Event) => {
    if (event.target !== textarea) return;
    input.flush();
    nativeComposing = true;
    nativeSettling = false;
    clearTimeout(settleTimer);
  };
  const onCompositionEnd = (event: Event) => {
    if (event.target !== textarea) return;
    nativeComposing = false;
    nativeSettling = true;
    settleTimer = setTimeout(() => { nativeSettling = false; }, 0);
  };
  const onCommit = (event: Event) => {
    if (event.target === textarea) input.flush();
  };
  const listeners: [string, (event: Event) => void][] = [
    ['input', onInput],
    ['keydown', onKeyDown],
    ['compositionstart', onCompositionStart],
    ['compositionend', onCompositionEnd],
    ['blur', onCommit],
    ['paste', onCommit],
  ];
  // Parent capture runs before xterm's capture listeners on the textarea.
  for (const [type, listener] of listeners) element.addEventListener(type, listener, true);
  const render = terminal.onRender(positionPreview);
  const resize = terminal.onResize(positionPreview);

  return {
    reset: input.reset,
    dispose: () => {
      input.reset();
      clearTimeout(settleTimer);
      for (const [type, listener] of listeners) element.removeEventListener(type, listener, true);
      render.dispose();
      resize.dispose();
      view.remove();
    },
  };
};
