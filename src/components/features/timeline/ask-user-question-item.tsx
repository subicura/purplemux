import { useState, useMemo, memo, type ChangeEvent, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { MessageCircleQuestion, Check, Send, Loader2, PencilLine } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { buildKeySequence, type TAskInputStep, type TAskSelections, type TAskCustomAnswers } from '@/lib/ask-question-keys';
import { answeredCustomAnswer, answeredLabels } from '@/lib/ask-question-answer';
import type { ITimelineAskUserQuestion, IAskUserQuestionItem } from '@/types/timeline';

interface IAskUserQuestionItemProps {
  entry: ITimelineAskUserQuestion;
  sessionName?: string;
}

const postInputSequence = async (session: string, sequence: TAskInputStep[]): Promise<boolean> => {
  try {
    const res = await fetch('/api/tmux/send-input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, sequence }),
    });
    return res.ok;
  } catch {
    return false;
  }
};

const allowsCustomAnswer = (question: IAskUserQuestionItem): boolean =>
  !question.multiSelect && question.allowCustomAnswer !== false;

const customOptionIndex = (question: IAskUserQuestionItem): number => question.options.length;

const AskUserQuestionItem = ({ entry, sessionName }: IAskUserQuestionItemProps) => {
  const t = useTranslations('timeline');
  const [selections, setSelections] = useState<TAskSelections>({});
  const [customAnswers, setCustomAnswers] = useState<TAskCustomAnswers>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const isAnswered = entry.status === 'success';
  const canInteract = !isAnswered && !submitted && !!sessionName;

  const allAnswered = useMemo(
    () => entry.questions.every((question, qIdx) => {
      const selected = selections[qIdx] ?? [];
      if (
        allowsCustomAnswer(question) &&
        selected[0] === customOptionIndex(question)
      ) {
        return (customAnswers[qIdx]?.trim().length ?? 0) > 0;
      }
      return selected.length > 0;
    }),
    [entry.questions, selections, customAnswers],
  );

  if (entry.questions.length === 0) return null;

  const toggle = (question: IAskUserQuestionItem, qIdx: number, optIdx: number) => {
    if (!canInteract) return;
    if (!question.multiSelect && optIdx !== customOptionIndex(question)) {
      setCustomAnswers((prev) => {
        if (!(qIdx in prev)) return prev;
        const next = { ...prev };
        delete next[qIdx];
        return next;
      });
    }
    setSelections((prev) => {
      const cur = prev[qIdx] ?? [];
      if (question.multiSelect) {
        const next = cur.includes(optIdx) ? cur.filter((i) => i !== optIdx) : [...cur, optIdx];
        return { ...prev, [qIdx]: next };
      }
      return { ...prev, [qIdx]: [optIdx] };
    });
  };

  const handleSubmit = async () => {
    if (!canInteract || !allAnswered || !sessionName) return;
    setSubmitting(true);
    const ok = await postInputSequence(sessionName, buildKeySequence(entry.questions, selections, customAnswers));
    setSubmitting(false);
    if (!ok) {
      toast.error(t('selectionFailed'));
      return;
    }
    setSubmitted(true);
  };

  const handleCustomAnswerChange = (question: IAskUserQuestionItem, qIdx: number, event: ChangeEvent<HTMLInputElement>) => {
    if (!canInteract) return;
    setSelections((prev) => ({ ...prev, [qIdx]: [customOptionIndex(question)] }));
    setCustomAnswers((prev) => ({ ...prev, [qIdx]: event.target.value }));
  };

  const handleCustomAnswerKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || !allAnswered || submitting) return;
    event.preventDefault();
    void handleSubmit();
  };

  const isOptionSelected = (question: IAskUserQuestionItem, qIdx: number, optIdx: number): boolean => {
    if (isAnswered) return answeredLabels(entry, question, qIdx).includes(question.options[optIdx]?.label ?? '');
    return (selections[qIdx] ?? []).includes(optIdx);
  };

  const isCustomAnswerSelected = (question: IAskUserQuestionItem, qIdx: number): boolean => {
    if (isAnswered) return answeredCustomAnswer(entry, question, qIdx) !== '';
    return (selections[qIdx] ?? [])[0] === customOptionIndex(question);
  };

  return (
    <div className="animate-in fade-in flex flex-col gap-2 duration-150">
      {entry.questions.map((question, qIdx) => (
        <div
          key={qIdx}
          className="rounded-lg border border-claude-active/20 bg-claude-active/5 px-4 py-3"
        >
          <div className="mb-2.5 flex items-center gap-2 text-xs font-medium text-claude-active">
            <MessageCircleQuestion size={14} />
            <span>{question.header}</span>
            {question.multiSelect && !isAnswered && (
              <span className="text-[10px] font-normal text-muted-foreground">
                {t('askMultiSelectHint')}
              </span>
            )}
          </div>

          <p className="mb-3 text-sm">{question.question}</p>

          <div className="flex flex-col gap-1.5">
            {question.options.map((option, optIdx) => {
              const selected = isOptionSelected(question, qIdx, optIdx);
              const dimmed = (isAnswered || submitted) && !selected;

              return (
                <button
                  key={optIdx}
                  type="button"
                  disabled={!canInteract}
                  onClick={() => toggle(question, qIdx, optIdx)}
                  className={cn(
                    'flex items-start gap-2.5 rounded-md border px-3 py-2 text-left text-sm transition-colors',
                    selected
                      ? 'border-claude-active/40 bg-claude-active/10'
                      : dimmed
                        ? 'border-border/30 opacity-50'
                        : 'border-border/50',
                    canInteract && 'cursor-pointer hover:border-claude-active/30 hover:bg-claude-active/5',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-xs font-medium',
                      question.multiSelect ? 'rounded-sm' : 'rounded',
                      selected ? 'bg-claude-active text-white' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {selected ? <Check size={12} /> : optIdx + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <span className="font-medium">{option.label}</span>
                    {option.description && (
                      <p className="mt-0.5 text-xs text-muted-foreground">{option.description}</p>
                    )}
                  </div>
                </button>
              );
            })}
            {allowsCustomAnswer(question) && (() => {
              const selected = isCustomAnswerSelected(question, qIdx);
              const customText = isAnswered
                ? answeredCustomAnswer(entry, question, qIdx)
                : customAnswers[qIdx] ?? '';
              const dimmed = (isAnswered || submitted) && !selected;

              return (
                <div
                  className={cn(
                    'rounded-md border text-sm transition-colors',
                    selected
                      ? 'border-claude-active/40 bg-claude-active/10'
                      : dimmed
                        ? 'border-border/30 opacity-50'
                        : 'border-border/50',
                    canInteract && 'hover:border-claude-active/30 hover:bg-claude-active/5',
                  )}
                >
                  <button
                    type="button"
                    disabled={!canInteract}
                    onClick={() => toggle(question, qIdx, customOptionIndex(question))}
                    className="flex w-full items-start gap-2.5 px-3 py-2 text-left"
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-xs font-medium',
                        selected ? 'bg-claude-active text-white' : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {selected ? <Check size={12} /> : <PencilLine size={12} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="font-medium">{t('askCustomAnswerLabel')}</span>
                    </div>
                  </button>
                  {selected && !isAnswered && (
                    <div className="px-3 pb-3 pl-10">
                      <Input
                        value={customText}
                        disabled={!canInteract}
                        onChange={(event) => handleCustomAnswerChange(question, qIdx, event)}
                        onKeyDown={handleCustomAnswerKeyDown}
                        placeholder={t('askCustomAnswerPlaceholder')}
                        aria-label={`${question.header} ${t('askCustomAnswerLabel')}`}
                        className="h-8 border-border/60 bg-background/80 text-sm"
                      />
                    </div>
                  )}
                  {selected && isAnswered && customText && (
                    <p className="px-3 pb-3 pl-10 text-sm text-foreground">{customText}</p>
                  )}
                </div>
              );
            })()}
          </div>
        </div>
      ))}

      {canInteract && (
        <button
          type="button"
          disabled={!allAnswered || submitting}
          onClick={handleSubmit}
          className={cn(
            'flex items-center justify-center gap-1.5 rounded-lg border px-4 py-2 text-sm font-medium transition-colors',
            allAnswered && !submitting
              ? 'cursor-pointer border-claude-active/40 bg-claude-active/10 text-claude-active hover:bg-claude-active/15'
              : 'border-border/40 text-muted-foreground opacity-60',
          )}
        >
          {submitting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          {t('askSubmit')}
        </button>
      )}
    </div>
  );
};

export default memo(AskUserQuestionItem);
