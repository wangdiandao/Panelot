import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import bash from 'shiki/langs/bash.mjs';
import css from 'shiki/langs/css.mjs';
import html from 'shiki/langs/html.mjs';
import javascript from 'shiki/langs/javascript.mjs';
import json from 'shiki/langs/json.mjs';
import markdown from 'shiki/langs/markdown.mjs';
import python from 'shiki/langs/python.mjs';
import sql from 'shiki/langs/sql.mjs';
import tsx from 'shiki/langs/tsx.mjs';
import typescript from 'shiki/langs/typescript.mjs';
import yaml from 'shiki/langs/yaml.mjs';
import vitesseDark from 'shiki/themes/vitesse-dark.mjs';
import vitesseLight from 'shiki/themes/vitesse-light.mjs';

const aliases: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  sh: 'bash',
  shell: 'bash',
  yml: 'yaml',
  md: 'markdown',
  py: 'python',
  html: 'html',
  xml: 'html',
};

const highlighter = createHighlighterCore({
  themes: [vitesseLight, vitesseDark],
  langs: [bash, css, html, javascript, json, markdown, python, sql, tsx, typescript, yaml],
  engine: createJavaScriptRegexEngine(),
});

export async function highlightCode(code: string, language: string): Promise<string | null> {
  const instance = await highlighter;
  const requested = aliases[language.toLowerCase()] ?? language.toLowerCase();
  const loaded = new Set(instance.getLoadedLanguages());
  if (!loaded.has(requested)) return null;
  return instance.codeToHtml(code, {
    lang: requested,
    themes: { light: 'vitesse-light', dark: 'vitesse-dark' },
    defaultColor: false,
  });
}
