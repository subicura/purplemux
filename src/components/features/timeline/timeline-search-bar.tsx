import { memo, type KeyboardEvent, type RefObject } from 'react';
import { useTranslations } from 'next-intl';
import { Search, X, ChevronUp, ChevronDown } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface ITimelineSearchBarProps {
  query: string;
  onQueryChange: (value: string) => void;
  matchCount: number;
  currentIndex: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

const TimelineSearchBar = ({
  query,
  onQueryChange,
  matchCount,
  currentIndex,
  onNext,
  onPrev,
  onClose,
  inputRef,
}: ITimelineSearchBarProps) => {
  const t = useTranslations('timeline');

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) onPrev();
      else onNext();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const hasQuery = query.trim().length > 0;

  return (
    <div className="absolute right-3 top-3 z-20 flex items-center gap-1.5 rounded-lg border border-border/60 bg-background/95 px-2 py-1.5 shadow-md backdrop-blur">
      <Search size={14} className="shrink-0 text-muted-foreground" />
      <Input
        ref={inputRef}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('searchPlaceholder')}
        className="h-7 w-48 border-0 bg-transparent px-1 text-sm shadow-none focus-visible:ring-0"
      />
      <span className="min-w-[3.5rem] shrink-0 text-center text-xs tabular-nums text-muted-foreground">
        {hasQuery ? `${matchCount > 0 ? currentIndex + 1 : 0}/${matchCount}` : ''}
      </span>
      <button
        type="button"
        onClick={onPrev}
        disabled={matchCount === 0}
        aria-label={t('searchPrev')}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded transition-colors',
          matchCount === 0 ? 'text-muted-foreground/40' : 'cursor-pointer text-muted-foreground hover:bg-muted',
        )}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={matchCount === 0}
        aria-label={t('searchNext')}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded transition-colors',
          matchCount === 0 ? 'text-muted-foreground/40' : 'cursor-pointer text-muted-foreground hover:bg-muted',
        )}
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label={t('searchClose')}
        className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted"
      >
        <X size={14} />
      </button>
    </div>
  );
};

export default memo(TimelineSearchBar);
