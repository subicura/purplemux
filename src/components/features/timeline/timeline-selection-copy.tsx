import { useCallback, useEffect, useState, type RefObject } from 'react';
import { useTranslations } from 'next-intl';
import { Copy, Check } from 'lucide-react';
import { copyToClipboard } from '@/lib/clipboard';
import { selectionToMarkdown } from '@/lib/selection-markdown';

interface ITimelineSelectionCopyProps {
  scrollRef: RefObject<HTMLElement | null>;
}

interface IAnchor {
  x: number;
  y: number;
}

const BUTTON_W = 132;
const BUTTON_H = 30;
const GAP = 8;
const COPIED_HIDE_MS = 900;

/** 타임라인 선택 영역 위에 뜨는 "마크다운 복사" 버튼. Cmd+C(순수 텍스트)는 그대로 두고 옵션을 더한다. */
const TimelineSelectionCopy = ({ scrollRef }: ITimelineSelectionCopyProps) => {
  const t = useTranslations('timeline');
  const [anchor, setAnchor] = useState<IAnchor | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const isOnButton = (target: EventTarget | null) =>
      target instanceof HTMLElement && !!target.closest('[data-selection-copy]');

    const onMouseUp = (e: MouseEvent) => {
      if (isOnButton(e.target)) return;
      const { clientX, clientY } = e;
      window.setTimeout(() => {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
          setAnchor(null);
          return;
        }
        if (!selection.anchorNode || !container.contains(selection.anchorNode)) {
          setAnchor(null);
          return;
        }
        setCopied(false);
        setAnchor({ x: clientX, y: clientY });
      }, 0);
    };

    const onMouseDown = (e: MouseEvent) => {
      if (isOnButton(e.target)) return;
      setAnchor(null);
    };

    const onScroll = () => setAnchor(null);

    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mousedown', onMouseDown);
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('mousedown', onMouseDown);
      container.removeEventListener('scroll', onScroll);
    };
  }, [scrollRef]);

  const handleCopy = useCallback(async () => {
    const container = scrollRef.current;
    if (!container) return;
    const markdown = selectionToMarkdown(container);
    if (markdown && (await copyToClipboard(markdown))) {
      setCopied(true);
      window.setTimeout(() => setAnchor(null), COPIED_HIDE_MS);
    } else {
      setAnchor(null);
    }
  }, [scrollRef]);

  if (!anchor) return null;

  const left = Math.min(Math.max(GAP, anchor.x + GAP), window.innerWidth - BUTTON_W - GAP);
  const top = Math.min(Math.max(GAP, anchor.y - BUTTON_H - GAP), window.innerHeight - BUTTON_H - GAP);

  return (
    <button
      type="button"
      data-selection-copy
      onMouseDown={(e) => e.preventDefault()}
      onClick={handleCopy}
      style={{ left, top }}
      className="fixed z-50 flex items-center gap-1.5 rounded-md border border-border/60 bg-background/95 px-2.5 py-1.5 text-xs font-medium text-foreground shadow-md backdrop-blur transition-colors hover:bg-muted"
    >
      {copied ? <Check size={13} className="text-positive" /> : <Copy size={13} />}
      {t('copyAsMarkdown')}
    </button>
  );
};

export default TimelineSelectionCopy;
