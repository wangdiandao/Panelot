import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, Pencil, X } from 'lucide-react';
import type { InteractionResponse, PendingInteraction } from '../../messaging/protocol';
import { t } from '../i18n';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from './ui/card';
import { Field, FieldGroup } from './ui/field';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from './ui/input-group';
import { Textarea } from './ui/textarea';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';

interface Props {
  interaction: PendingInteraction;
  onResponse: (interactionId: string, response: InteractionResponse) => void;
}

export function InteractionCard({ interaction, onResponse }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const request = interaction.request;
  const [structuredValue, setStructuredValue] = useState('{}');
  const [structuredError, setStructuredError] = useState<string | null>(null);

  useEffect(() => ref.current?.focus(), [interaction.interactionId]);

  const respond = (response: InteractionResponse) =>
    onResponse(interaction.interactionId, response);

  if (request.kind === 'ask_user') {
    return (
      <AskUserSelector
        interactionId={interaction.interactionId}
        questions={request.questions}
        onResponse={onResponse}
      />
    );
  }

  const submit = () => {
    if (request.kind === 'mcp_elicitation') {
      try {
        respond({ kind: 'submit', value: JSON.parse(structuredValue) });
      } catch {
        setStructuredError(t('interaction.invalidJson'));
      }
    }
  };

  return (
    <Card ref={ref} tabIndex={-1} role="region" className="min-w-0 overflow-hidden">
      <CardHeader>
        <CardTitle>{interactionTitle(request.kind)}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {request.kind === 'user_action' && (
          <p className="whitespace-pre-wrap text-sm">{request.instruction}</p>
        )}
        {request.kind === 'watch_page' && (
          <p className="text-sm text-muted-foreground">{t('interaction.watching')}</p>
        )}
        {request.kind === 'schedule' && (
          <p className="text-sm text-muted-foreground">
            {request.reason} · {new Date(request.resumeAt).toLocaleString()}
          </p>
        )}
        {request.kind === 'mcp_elicitation' && (
          <div className="flex flex-col gap-2">
            <p className="whitespace-pre-wrap text-sm">{request.message}</p>
            <Textarea
              value={structuredValue}
              onChange={(event) => {
                setStructuredValue(event.target.value);
                setStructuredError(null);
              }}
              className="font-mono text-xs"
            />
            {structuredError && <p className="text-xs text-destructive">{structuredError}</p>}
          </div>
        )}
      </CardContent>
      <CardFooter className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => respond({ kind: 'cancel' })}>
          {t('app.cancel')}
        </Button>
        {request.kind === 'user_action' ? (
          <Button
            type="button"
            onClick={() => respond({ kind: 'submit', value: { completed: true } })}
          >
            {t('interaction.completed')}
          </Button>
        ) : request.kind === 'mcp_elicitation' ? (
          <Button type="button" onClick={submit}>
            {t('interaction.submit')}
          </Button>
        ) : null}
      </CardFooter>
    </Card>
  );
}

interface AskUserSelectorProps {
  interactionId: string;
  questions: Extract<PendingInteraction['request'], { kind: 'ask_user' }>['questions'];
  onResponse: (interactionId: string, response: InteractionResponse) => void;
}

type AskUserAnswer = {
  value: string;
  source: 'option' | 'freeform';
};

function AskUserSelector({ interactionId, questions, onResponse }: AskUserSelectorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, AskUserAnswer>>({});
  const question = questions[currentIndex];

  useEffect(() => {
    setCurrentIndex(0);
    setAnswers({});
    ref.current?.focus();
  }, [interactionId]);

  if (!question) {
    return null;
  }

  const respond = (response: InteractionResponse) => onResponse(interactionId, response);
  const submitAnswers = (nextAnswers: Record<string, AskUserAnswer>) => {
    respond({
      kind: 'submit',
      value: {
        answers: questions.map((item) => ({ id: item.id, ...nextAnswers[item.id]! })),
      },
    });
  };
  const answerQuestion = (answer: AskUserAnswer) => {
    const nextAnswers = { ...answers, [question.id]: answer };
    setAnswers(nextAnswers);
    const firstUnanswered = questions.findIndex((item) => !nextAnswers[item.id]);
    if (currentIndex === questions.length - 1 && firstUnanswered === -1) {
      submitAnswers(nextAnswers);
      return;
    }
    setCurrentIndex(
      firstUnanswered === -1 ? Math.min(currentIndex + 1, questions.length - 1) : firstUnanswered,
    );
  };
  const currentAnswer = answers[question.id];
  const freeformValue = currentAnswer?.source === 'freeform' ? currentAnswer.value : '';
  const submitFreeform = () => {
    const value = freeformValue.trim();
    if (value) answerQuestion({ value, source: 'freeform' });
  };

  return (
    <Card ref={ref} tabIndex={-1} role="region" className="mx-4 mb-4 gap-0 overflow-hidden py-0">
      <CardHeader className="gap-2 px-4 py-2 has-data-[slot=card-action]:grid-cols-1 sm:has-data-[slot=card-action]:grid-cols-[1fr_auto]">
        <CardTitle className="min-w-0 whitespace-normal">{question.question}</CardTitle>
        <CardAction className="col-start-1 row-start-2 flex items-center gap-1 sm:col-start-2 sm:row-span-2 sm:row-start-1">
          {questions.length > 1 && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('interaction.previousQuestion')}
                disabled={currentIndex === 0}
                onClick={() => setCurrentIndex((index) => Math.max(0, index - 1))}
              >
                <ChevronLeft />
              </Button>
              <span className="text-xs text-muted-foreground">
                {currentIndex + 1} {t('interaction.questionProgress')} {questions.length}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('interaction.nextQuestion')}
                disabled={currentIndex === questions.length - 1}
                onClick={() =>
                  setCurrentIndex((index) => Math.min(questions.length - 1, index + 1))
                }
              >
                <ChevronRight />
              </Button>
            </>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t('app.cancel')}
            onClick={() => respond({ kind: 'cancel' })}
          >
            <X />
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="px-2">
        <FieldGroup className="gap-1">
          <Field>
            <ToggleGroup
              type="single"
              orientation="vertical"
              value={currentAnswer?.source === 'option' ? currentAnswer.value : ''}
              onValueChange={(value) => value && answerQuestion({ value, source: 'option' })}
              className="w-full flex-col items-stretch gap-1"
            >
              {question.options?.map((option, index) => {
                const presentation = optionPresentation(option.label);
                const selected =
                  currentAnswer?.source === 'option' && currentAnswer.value === option.value;
                return (
                  <ToggleGroupItem
                    key={option.value}
                    value={option.value}
                    size="lg"
                    className="h-auto min-h-9 w-full justify-start whitespace-normal px-2 py-1.5 text-left"
                  >
                    <Badge variant="outline" className="size-7 px-0">
                      {index + 1}
                    </Badge>
                    <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5 sm:flex-nowrap">
                      <span className="shrink-0 font-medium">{presentation.label}</span>
                      {presentation.recommendation && (
                        <Badge variant="secondary">{presentation.recommendation}</Badge>
                      )}
                      {option.description && (
                        <span className="min-w-0 basis-full truncate text-xs font-normal text-muted-foreground sm:basis-auto">
                          {option.description}
                        </span>
                      )}
                    </span>
                    {selected && <ArrowRight />}
                  </ToggleGroupItem>
                );
              })}
            </ToggleGroup>
          </Field>
        </FieldGroup>
      </CardContent>
      <CardFooter className="gap-2 px-3 py-1.5">
        <InputGroup>
          <InputGroupAddon>
            <Pencil />
          </InputGroupAddon>
          <InputGroupInput
            value={freeformValue}
            aria-label={t('interaction.otherAnswer')}
            placeholder={t('interaction.otherAnswer')}
            onChange={(event) =>
              setAnswers((current) => ({
                ...current,
                [question.id]: { value: event.target.value, source: 'freeform' },
              }))
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submitFreeform();
              }
            }}
          />
          {freeformValue.trim() && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                variant="default"
                aria-label={t('interaction.submit')}
                onClick={submitFreeform}
              >
                <ArrowRight />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => respond({ kind: 'cancel' })}
        >
          {t('interaction.skip')}
        </Button>
      </CardFooter>
    </Card>
  );
}

function optionPresentation(label: string): { label: string; recommendation?: string } {
  const match = label.match(/^(.*?)\s*[（(](推荐|Recommended)[）)]\s*$/i);
  return match ? { label: match[1]!.trim(), recommendation: match[2] } : { label };
}

function interactionTitle(kind: PendingInteraction['request']['kind']): string {
  switch (kind) {
    case 'ask_user':
      return t('interaction.question');
    case 'user_action':
      return t('interaction.userAction');
    case 'watch_page':
      return t('interaction.watchPage');
    case 'schedule':
      return t('interaction.schedule');
    case 'mcp_elicitation':
      return t('interaction.mcp');
  }
}
