/**
 * Markdown renderer (docs/09 §4.1).
 *
 * Streaming rules (OpenWebUI lessons):
 *  1. Unclosed code fences render as plain <pre> until the fence closes —
 *     no Shiki/Mermaid on incomplete blocks (prevents flicker & errors).
 *  2. Mermaid/KaTeX render only for complete blocks; failures degrade to a
 *     plain code block.
 */

import { memo, useEffect, useId, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import type { Options as ReactMarkdownOptions } from 'react-markdown';
import { Check, Copy } from 'lucide-react';
import { t } from '../i18n';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';

type RemarkPlugin = NonNullable<ReactMarkdownOptions['remarkPlugins']>[number];
type RehypePlugin = NonNullable<ReactMarkdownOptions['rehypePlugins']>[number];

interface MarkdownRuntime {
  ReactMarkdown: ComponentType<ReactMarkdownOptions>;
  remarkGfm: RemarkPlugin;
  remarkMath: RemarkPlugin;
  rehypeKatex: RehypePlugin;
}

const markdownRuntime = Promise.all([
  import('react-markdown'),
  import('remark-gfm'),
  import('remark-math'),
  import('rehype-katex'),
  import('katex/dist/katex.min.css'),
]).then(([reactMarkdown, remarkGfm, remarkMath, rehypeKatex]) => ({
  ReactMarkdown: reactMarkdown.default,
  remarkGfm: remarkGfm.default,
  remarkMath: remarkMath.default,
  rehypeKatex: rehypeKatex.default,
}));

/** Count ``` fences to detect an unclosed trailing code block. */
export function splitUnclosedFence(markdown: string): { closed: string; openTail: string | null } {
  const fences = markdown.match(/^```/gm)?.length ?? 0;
  if (fences % 2 === 0) return { closed: markdown, openTail: null };
  const lastFence = markdown.lastIndexOf('```');
  return { closed: markdown.slice(0, lastFence), openTail: markdown.slice(lastFence) };
}

// ---------------------------------------------------------------------------

/**
 * Sticky action header (OpenWebUI CodeBlock): language label left, copy
 * right; the header stays reachable while a long block scrolls. Pure CSS
 * sticky — no interaction with the streaming fence-deferral rules.
 */
function CodeHeader({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="sticky top-0 z-10 flex items-center justify-between rounded-t-md bg-muted px-3 py-1 text-[11px] text-muted-foreground">
      <span className="truncate font-mono">{lang}</span>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        aria-label={t('actions.copy')}
        onClick={() => {
          void navigator.clipboard.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
        className="h-6"
      >
        {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
        {copied ? t('actions.copied') : t('actions.copy')}
      </Button>
    </div>
  );
}

function ShikiBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // Dual themes: tokens carry --shiki-light/dark variables; global.css picks
    // the active one via the .dark class, so code follows the app theme.
    import('../highlighter')
      .then(({ highlightCode }) => highlightCode(code, lang || 'text'))
      .then((h) => alive && setHtml(h))
      .catch(() => alive && setHtml(null));
    return () => {
      alive = false;
    };
  }, [code, lang]);
  return (
    <div className="relative overflow-hidden rounded-md border border-border/30">
      <CodeHeader lang={lang || 'text'} code={code} />
      {html === null ? (
        <pre className="overflow-x-auto bg-muted p-3 pt-1.5 font-mono text-xs">
          <code>{code}</code>
        </pre>
      ) : (
        // Shiki inlines the theme background — force the token surface instead
        // so highlighted and fallback blocks sit on the same bg-muted.
        <div
          className="shiki-block overflow-x-auto text-xs [&>pre]:!bg-muted [&>pre]:p-3 [&>pre]:pt-1.5"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}

function MermaidBlock({ code }: { code: string }) {
  const id = useId().replaceAll(':', '');
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    void import('../mermaidRuntime').then(({ renderMermaid }) => {
      try {
        const svg = renderMermaid(`m${id}`, code);
        if (alive && ref.current) ref.current.innerHTML = svg;
      } catch {
        if (alive) setFailed(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [code, id]);
  if (failed) return <ShikiBlock code={code} lang="text" />;
  return <div ref={ref} className="my-2 max-w-full overflow-x-auto" />;
}

// ---------------------------------------------------------------------------

interface MarkdownProps {
  content: string;
  /** True while the item is still streaming (enables fence deferral). */
  streaming?: boolean;
}

export const Markdown = memo(function Markdown({ content, streaming }: MarkdownProps) {
  const [runtime, setRuntime] = useState<MarkdownRuntime | null>(null);
  useEffect(() => {
    let alive = true;
    void markdownRuntime.then((loaded) => {
      if (alive) setRuntime(loaded);
    });
    return () => {
      alive = false;
    };
  }, []);
  const { closed, openTail } = streaming
    ? splitUnclosedFence(content)
    : { closed: content, openTail: null };
  if (!runtime) {
    return (
      <div className="min-w-0 break-words whitespace-pre-wrap [overflow-wrap:anywhere] text-[14.5px] leading-[1.7]">
        {content}
      </div>
    );
  }
  const ReactMarkdown = runtime.ReactMarkdown;

  return (
    <div className="markdown-body min-w-0 max-w-full break-words [overflow-wrap:anywhere] text-[14.5px] leading-[1.7] [&>*+*]:mt-3 [&_h1]:mt-4 [&_h1]:text-[18px] [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:text-[16px] [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:text-[15px] [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-0.5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground">
      <ReactMarkdown
        remarkPlugins={[runtime.remarkGfm, runtime.remarkMath]}
        rehypePlugins={[runtime.rehypeKatex]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className ?? '');
            const text = String(children).replace(/\n$/, '');
            if (!match) {
              return (
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[13px]" {...props}>
                  {children}
                </code>
              );
            }
            if (match[1] === 'mermaid') return <MermaidBlock code={text} />;
            return <ShikiBlock code={text} lang={match[1]!} />;
          },
          a({ href, children }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline decoration-primary/40 hover:decoration-primary"
              >
                {children}
              </a>
            );
          },
          table({ children }) {
            return (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13px] [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-2 [&_th]:py-1">
                  {children}
                </table>
              </div>
            );
          },
        }}
      >
        {closed}
      </ReactMarkdown>
      {openTail !== null && (
        <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs opacity-90">
          {openTail.replace(/^```\w*\n?/, '')}
          <Skeleton className="inline-block h-3.5 w-2 align-text-bottom" />
        </pre>
      )}
    </div>
  );
});
