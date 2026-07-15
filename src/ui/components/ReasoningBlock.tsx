import { useEffect, useRef } from 'react';
import { cn } from '../lib/utils';

export function ReasoningBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (streaming && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [text, streaming]);

  return (
    <div
      ref={contentRef}
      role={streaming ? 'status' : undefined}
      className={cn(
        'overflow-y-auto whitespace-pre-wrap text-sm leading-7 text-muted-foreground',
        streaming ? 'max-h-40' : 'max-h-72',
      )}
    >
      {text}
    </div>
  );
}
