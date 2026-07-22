// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildSnapshot,
  computeName,
  computeRole,
  isInteractive,
} from '../../src/tools/snapshot/engine';

function setBody(html: string): Window {
  document.body.innerHTML = html;
  return window as unknown as Window;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = 'Test Page';
});

const snap = (html: string, id = 1) =>
  buildSnapshot(setBody(html), { snapshotId: id, documentToken: 'doc' });

describe('interactive detection (docs/development/browser-tools.md §1.2 — recall first)', () => {
  it('grants refs to semantic controls', () => {
    const result = snap(`
      <button>提交</button>
      <a href="/x">链接</a>
      <input type="text" placeholder="邮箱">
      <select><option>甲</option></select>
      <textarea></textarea>
    `);
    // button, link, input, select (+ its option), textarea all get refs.
    expect(result.refMap.size).toBeGreaterThanOrEqual(5);
    expect(result.yaml).toContain('button "提交" [ref=sdoc_1_');
    expect(result.yaml).toContain('link "链接" [ref=sdoc_1_');
    expect(result.yaml).toContain('textbox "邮箱"');
  });

  it('grants refs to role/tabindex/contenteditable elements', () => {
    const result = snap(`
      <div role="button">自定义按钮</div>
      <div tabindex="0">可聚焦</div>
      <div contenteditable="true">编辑区</div>
    `);
    expect(result.yaml).toContain('button "自定义按钮" [ref=');
    expect(result.refMap.size).toBe(3);
  });

  it('folds nested clickable chains to the innermost target (nanobrowser lesson)', () => {
    // Outer div with pointer cursor wrapping a real button: only the button gets a ref.
    const result = snap(`
      <div style="cursor:pointer" id="outer">
        <button id="inner">真实按钮</button>
      </div>
    `);
    const refs = [...result.refMap.values()];
    expect(refs).toHaveLength(1);
    expect(refs[0]!.id).toBe('inner');
  });

  it('keeps a pointer-cursor div with NO interactive descendant (recall over precision)', () => {
    const win = setBody(`<div style="cursor:pointer">纯 div 卡片</div>`);
    const div = win.document.querySelector('div')!;
    expect(isInteractive(div, win)).toBe(true);
    const result = buildSnapshot(win, { snapshotId: 1 });
    expect(result.refMap.size).toBe(1);
  });
});

describe('roles, names, ARIA states (docs/development/browser-tools.md §1.1)', () => {
  it('computes roles from tags and input types', () => {
    setBody(`<input type="checkbox" id="c"><h2 id="h">标题</h2><a id="a" href="#">x</a>`);
    expect(computeRole(document.getElementById('c')!)).toBe('checkbox');
    expect(computeRole(document.getElementById('h')!)).toBe('heading');
    expect(computeRole(document.getElementById('a')!)).toBe('link');
  });

  it('resolves accessible names: aria-label > label[for] > placeholder', () => {
    const win = setBody(`
      <input id="i1" aria-label="用户名">
      <label for="i2">密码</label><input id="i2" type="password">
      <input id="i3" placeholder="搜索…">
    `);
    expect(computeName(win.document.getElementById('i1')!, win)).toBe('用户名');
    expect(computeName(win.document.getElementById('i2')!, win)).toBe('密码');
    expect(computeName(win.document.getElementById('i3')!, win)).toBe('搜索…');
  });

  it('renders value echo and ARIA states in brackets', () => {
    const result = snap(`
      <input type="text" aria-label="邮箱" value="user@example.com">
      <input type="checkbox" aria-label="记住我" checked>
      <button disabled>禁用钮</button>
      <div role="button" aria-expanded="true">菜单</div>
    `);
    expect(result.yaml).toContain('[value="user@example.com"]');
    expect(result.yaml).toContain('checkbox "记住我" [checked]');
    expect(result.yaml).toContain('[disabled]');
    expect(result.yaml).toContain('[expanded]');
  });

  it('hides display:none / aria-hidden content', () => {
    const result = snap(`
      <button style="display:none">看不见</button>
      <button aria-hidden="true">也看不见</button>
      <button>看得见</button>
    `);
    expect(result.refMap.size).toBe(1);
    expect(result.yaml).not.toContain('看不见');
  });
});

describe('ref versioning (docs/development/browser-tools.md §1.1 — expiry at the protocol level)', () => {
  it('embeds the snapshot id in every ref', () => {
    const result = snap(`<button>a</button>`, 7);
    expect([...result.refMap.keys()][0]).toMatch(/^sdoc_7_\d+$/);
    expect(result.yaml).toContain('[ref=sdoc_7_1]');
  });

  it('keeps a document nonce stable across snapshots and changes it across documents', () => {
    const first = buildSnapshot(setBody('<button>a</button>'), { snapshotId: 1 });
    const second = buildSnapshot(window as unknown as Window, { snapshotId: 2 });
    const otherDocument = document.implementation.createHTMLDocument('other');
    otherDocument.body.innerHTML = '<button>b</button>';
    const otherWindow = { document: otherDocument, location: window.location } as unknown as Window;
    const third = buildSnapshot(otherWindow, { snapshotId: 1 });

    expect(second.documentToken).toBe(first.documentToken);
    expect(third.documentToken).not.toBe(first.documentToken);
  });
});

describe('volume control (docs/development/browser-tools.md §1.3 — never silently truncate)', () => {
  it('drops non-interactive text under budget pressure and reports the count', () => {
    const longText = Array.from(
      { length: 200 },
      (_, i) => `<p>这是很长的段落文本内容 ${i}，用来撑爆预算。重复的填充文字。</p>`,
    ).join('');
    const result = buildSnapshot(setBody(`${longText}<button>重要按钮</button>`), {
      snapshotId: 1,
      maxTokens: 200,
    });
    expect(result.truncatedNodes).toBeGreaterThan(0);
    expect(result.yaml).toContain('[已截断:');
    // Interactive elements survive truncation.
    expect(result.yaml).toContain('重要按钮');
  });

  it('produces an empty-but-explicit tree for a blank page (no dead loops)', () => {
    const result = snap('');
    expect(result.refMap.size).toBe(0);
    expect(result.yaml).toContain('# Page Snapshot');
  });
});

describe('structure rendering', () => {
  it('renders a realistic login form as an indented tree', () => {
    const result = snap(`
      <form aria-label="登录表单">
        <h1>登录</h1>
        <input type="text" aria-label="邮箱" value="user@example.com">
        <input type="password" aria-label="密码">
        <input type="checkbox" aria-label="记住我" checked>
        <button>登录</button>
      </form>
      <a href="/forgot">忘记密码？</a>
      <p>还没有账号？<a href="/signup">注册</a></p>
    `);
    expect(result.yaml).toContain('form "');
    expect(result.yaml).toContain('- heading "登录" [level=1]');
    // Form children are indented one level under the form.
    const lines = result.yaml.split('\n');
    const formIdx = lines.findIndex((l) => l.includes('form "'));
    const emailIdx = lines.findIndex((l) => l.includes('邮箱'));
    expect(emailIdx).toBeGreaterThan(formIdx);
    expect(lines[emailIdx]!.startsWith('  ')).toBe(true);
    expect(result.yaml).toContain('text: "还没有账号？"');
    expect(result.yaml).toContain('link "注册"');
  });
});
