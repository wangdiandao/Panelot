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
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { codeToHtml } from 'shiki';
import 'katex/dist/katex.min.css';

/** Count ``` fences to detect an unclosed trailing code block. */
export function splitUnclosedFence(markdown: string): { closed: string; openTail: string | null } {
  const fences = markdown.match(/^```/gm)?.length ?? 0;
  if (fences % 2 === 0) return { closed: markdown, openTail: null };
  const lastFence = markdown.lastIndexOf('```');
  return { closed: markdown.slice(0, lastFence), openTail: markdown.slice(lastFence) };
}

// ---------------------------------------------------------------------------

function ShikiBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    codeToHtml(code, { lang: lang || 'text', theme: 'vitesse-dark' })
      .then((h) => alive && setHtml(h))
      .catch(() => alive && setHtml(null));
    return () => {
      alive = false;
    };
  }, [code, lang]);
  if (html === null) {
    return (
      <pre className="overflow-x-auto rounded-md bg-surface-2 p-3 font-mono text-xs">
        <code>{code}</code>
      </pre>
    );
  }
  return <div className="shiki-block overflow-x-auto text-xs [&>pre]:rounded-md [&>pre]:p-3" dangerouslySetInnerHTML={{ __html: html }} />;
}

function MermaidBlock({ code }: { code: string }) {
  const id = useId().replaceAll(':', '');
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    void import('mermaid').then(async ({ default: mermaid }) => {
      try {
        mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });
        const { svg } = await mermaid.render(`m${id}`, code);
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
  return <div ref={ref} className="my-2 flex justify-center" />;
}

// ---------------------------------------------------------------------------

interface MarkdownProps {
  content: string;
  /** True while the item is still streaming (enables fence deferral). */
  streaming?: boolean;
}

export const Markdown = memo(function Markdown({ content, streaming }: MarkdownProps) {
  const { closed, openTail } = streaming ? splitUnclosedFence(content) : { closed: content, openTail: null };

  return (
    <div className="markdown-body space-y-2 text-[14px] leading-[1.6]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className ?? '');
            const text = String(children).replace(/\n$/, '');
            if (!match) {
              return (
                <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[12.5px]" {...props}>
                  {children}
                </code>
              );
            }
            if (match[1] === 'mermaid') return <MermaidBlock code={text} />;
            return <ShikiBlock code={text} lang={match[1]!} />;
          },
          a({ href, children }) {
            return (
              <a href={href} target="_blank" rel="noreferrer" className="text-accent underline decoration-accent/40 hover:decoration-accent">
                {children}
              </a>
            );
          },
          table({ children }) {
            return (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13px] [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:bg-surface-2 [&_th]:px-2 [&_th]:py-1">
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
        <pre className="overflow-x-auto rounded-md bg-surface-2 p-3 font-mono text-xs opacity-90">
          {openTail.replace(/^```\w*\n?/, '')}
          <span className="inline-block h-3.5 w-2 animate-pulse bg-accent align-text-bottom" />
        </pre>
      )}
    </div>
  );
});
