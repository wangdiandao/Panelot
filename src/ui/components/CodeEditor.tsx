/**
 * CodeMirror-based editor for SKILL.md (docs/08 §3): markdown highlighting,
 * follows the app theme (.dark class). Thin controlled wrapper — validation
 * stays in the caller.
 */

import { useEffect, useRef } from 'react';
import { EditorView, keymap, lineNumbers, placeholder as cmPlaceholder } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  minHeight?: string;
  ariaLabel: string;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
}

export function CodeEditor({
  value,
  onChange,
  placeholder,
  minHeight = '360px',
  ariaLabel,
  ariaInvalid = false,
  ariaDescribedBy,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeCompartment = useRef(new Compartment());
  const accessibilityCompartment = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!hostRef.current) return;
    const isDark = () => document.documentElement.classList.contains('dark');
    const baseTheme = EditorView.theme({
      '&': { fontSize: '12.5px', minHeight },
      '.cm-content': { fontFamily: 'var(--font-mono)', minHeight },
      '.cm-gutters': { fontFamily: 'var(--font-mono)' },
      '&.cm-focused': { outline: 'none' },
    });
    // Keep one-dark's syntax colors but let the chrome follow the app's
    // surface tokens — otherwise its own #282c34 paints a two-tone frame
    // inside the bg-muted wrapper.
    const surfaceTheme = EditorView.theme({
      '&': { backgroundColor: 'var(--muted)' },
      '.cm-gutters': { backgroundColor: 'var(--muted)' },
    });
    const darkExtensions = [oneDark, surfaceTheme];

    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          markdown(),
          baseTheme,
          themeCompartment.current.of(isDark() ? darkExtensions : []),
          accessibilityCompartment.current.of(
            EditorView.contentAttributes.of({
              'aria-label': ariaLabel,
              'aria-invalid': String(ariaInvalid),
              ...(ariaDescribedBy ? { 'aria-describedby': ariaDescribedBy } : {}),
            }),
          ),
          ...(placeholder ? [cmPlaceholder(placeholder)] : []),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;

    // Track theme flips (useTheme toggles .dark on <html>).
    const observer = new MutationObserver(() => {
      view.dispatch({
        effects: themeCompartment.current.reconfigure(isDark() ? darkExtensions : []),
      });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => {
      observer.disconnect();
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value changes (e.g. template load) sync into the editor.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: accessibilityCompartment.current.reconfigure(
        EditorView.contentAttributes.of({
          'aria-label': ariaLabel,
          'aria-invalid': String(ariaInvalid),
          ...(ariaDescribedBy ? { 'aria-describedby': ariaDescribedBy } : {}),
        }),
      ),
    });
  }, [ariaDescribedBy, ariaInvalid, ariaLabel]);

  return <div ref={hostRef} className="overflow-hidden rounded-md border border-border bg-muted" />;
}
