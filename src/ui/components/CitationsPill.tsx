/**
 * CitationsPill — "read N pages" under an assistant message (OpenWebUI
 * Citations, adapted): favicon stack + count collapsed into one pill,
 * expanding to the list of URLs the agent visited in that turn. Data comes
 * from same-turn tool_call params (navigate/open_tab URLs) — the honest
 * record of where the agent actually went, not model-claimed sources.
 */

import { useState } from 'react';
import { Globe } from 'lucide-react';
import { t } from '../i18n';
import { Button } from './ui/button';

export interface Citation {
  url: string;
}

function faviconUrl(pageUrl: string): string | null {
  try {
    // MV3 _favicon endpoint (needs the "favicon" manifest permission).
    const u = new URL(chrome.runtime.getURL('/_favicon/'));
    u.searchParams.set('pageUrl', pageUrl);
    u.searchParams.set('size', '16');
    return u.toString();
  } catch {
    return null;
  }
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function CitationsPill({ citations }: { citations: Citation[] }) {
  const [open, setOpen] = useState(false);
  if (citations.length === 0) return null;
  const shown = citations.slice(0, 3);
  return (
    <div className="mt-1.5">
      <Button
        variant="outline"
        size="sm"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="h-7 rounded-full"
      >
        <span className="flex [&>*+*]:-ml-1">
          {shown.map((c, i) => (
            <Favicon key={i} url={c.url} />
          ))}
        </span>
        {t('citations.count', { n: citations.length })}
      </Button>
      {open && (
        <div className="mt-1 flex flex-col gap-0.5">
          {citations.map((c, i) => (
            <Button
              variant="ghost"
              size="sm"
              key={i}
              type="button"
              onClick={() => void chrome.tabs.create({ url: c.url })}
              className="h-auto w-full justify-start"
              title={c.url}
            >
              <Favicon url={c.url} />
              <span className="truncate font-mono text-[11px]">{domainOf(c.url)}</span>
              <span className="min-w-0 truncate text-faint-foreground">{c.url}</span>
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function Favicon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const src = faviconUrl(url);
  if (!src || failed)
    return (
      <Globe className="size-4 rounded-full bg-background p-0.5 text-faint-foreground ring-1 ring-border" />
    );
  return (
    <img
      src={src}
      alt=""
      className="size-4 rounded-full bg-background ring-1 ring-border"
      onError={() => setFailed(true)}
    />
  );
}
