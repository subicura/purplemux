import { useState, useMemo, memo } from 'react';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { DiffView, DiffModeEnum, getLang } from '@git-diff-view/react';
import { generateDiffFile } from '@git-diff-view/file';
import {
  FileText,
  FilePen,
  FilePlus,
  Terminal,
  Search,
  Wrench,
  Users,
  Globe,
  SearchCode,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import useIsMobile from '@/hooks/use-is-mobile';
import useConfigStore from '@/hooks/use-config-store';
import type { ITimelineToolCall, ITimelineToolResult, TToolName } from '@/types/timeline';

interface IToolCallItemProps {
  entry: ITimelineToolCall;
  result?: ITimelineToolResult;
}

const DIFF_FONT_SIZE: Record<string, number> = {
  normal: 11,
  large: 13,
  'x-large': 15,
};

const TOOL_ICONS: Record<string, typeof FileText> = {
  Read: FileText,
  Edit: FilePen,
  Write: FilePlus,
  Bash: Terminal,
  Grep: Search,
  Glob: Search,
  Agent: Users,
  WebSearch: Globe,
  WebFetch: Globe,
  ToolSearch: SearchCode,
};

const renderToolIcon = (toolName: TToolName, size: number) => {
  const IconComponent = TOOL_ICONS[toolName] ?? Wrench;
  return <IconComponent size={size} />;
};

const InlineDiffView = ({
  oldString,
  newString,
  filePath,
}: {
  oldString: string;
  newString: string;
  filePath?: string;
}) => {
  const { resolvedTheme } = useTheme();
  const theme: 'light' | 'dark' = resolvedTheme === 'light' ? 'light' : 'dark';
  const isMobile = useIsMobile();
  const fontSize = useConfigStore((s) => s.fontSize);
  const diffFontSize = DIFF_FONT_SIZE[fontSize] ?? DIFF_FONT_SIZE.normal;

  const diffFile = useMemo(() => {
    const name = filePath ? filePath.split('/').pop() || filePath : 'file';
    const lang = getLang(name);
    const file = generateDiffFile(name, oldString, name, newString, lang, lang, { context: 3 });
    file.initTheme(theme);
    file.init();
    file.buildSplitDiffLines();
    file.buildUnifiedDiffLines();
    return file;
  }, [oldString, newString, filePath, theme]);

  return (
    <div className="diff-panel-content mt-1.5 overflow-hidden rounded border border-border text-xs">
      <DiffView
        diffFile={diffFile}
        diffViewMode={DiffModeEnum.Unified}
        diffViewTheme={theme}
        diffViewHighlight
        diffViewWrap={isMobile}
        diffViewFontSize={diffFontSize}
      />
    </div>
  );
};

const ToolCallItem = ({ entry, result }: IToolCallItemProps) => {
  const t = useTranslations('timeline');
  const [isDiffOpen, setIsDiffOpen] = useState(false);
  const hasDiff = entry.diff && (entry.diff.oldString || entry.diff.newString);

  const statusColor = {
    pending: 'text-ui-amber',
    success: 'text-muted-foreground',
    error: 'text-negative',
  }[entry.status];

  const statusPulse = entry.status === 'pending' ? 'animate-pulse' : '';

  return (
    <div className="py-1">
      <div className="flex items-start gap-1.5">
        <span className={cn('shrink-0 mt-0.5', statusColor, statusPulse)}>
          {renderToolIcon(entry.toolName, 12)}
        </span>
        <div className="min-w-0 flex-1">
          <span className="block whitespace-pre-wrap break-all font-mono text-xs">{entry.summary}</span>
          {result && result.summary && !(hasDiff && !result.isError) && (
            <p
              className={cn(
                'mt-0.5 text-xs whitespace-pre-wrap break-words font-mono',
                result.isError ? 'text-negative/70' : 'text-muted-foreground/60',
              )}
            >
              {result.summary}
            </p>
          )}
        </div>
      </div>
      {hasDiff && (
        <>
          <button
            className="ml-4 mt-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            onClick={() => setIsDiffOpen((prev) => !prev)}
          >
            {isDiffOpen ? `▾ ${t('diffHide')}` : `▸ ${t('diffShow')}`}
          </button>
          {isDiffOpen && entry.diff && (
            <div className="ml-4">
              <InlineDiffView
                oldString={entry.diff.oldString}
                newString={entry.diff.newString}
                filePath={entry.diff.filePath}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default memo(ToolCallItem);
