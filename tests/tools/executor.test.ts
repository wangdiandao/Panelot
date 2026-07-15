// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionRunner } from '../../src/tools/action/runner';
import { executeContentTool } from '../../src/tools/content/executor';

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = 'Fixture';
  Object.defineProperty(window, 'scrollX', { configurable: true, value: 0 });
  Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
});

function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function setFrameGeometry(
  frame: HTMLIFrameElement,
  geometry: {
    left: number;
    top: number;
    width: number;
    height: number;
    offsetWidth: number;
    offsetHeight: number;
    clientWidth: number;
    clientHeight: number;
    clientLeft: number;
    clientTop: number;
    innerWidth: number;
    innerHeight: number;
  },
): void {
  vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(
    domRect(geometry.left, geometry.top, geometry.width, geometry.height),
  );
  for (const key of [
    'offsetWidth',
    'offsetHeight',
    'clientWidth',
    'clientHeight',
    'clientLeft',
    'clientTop',
  ] as const) {
    Object.defineProperty(frame, key, { configurable: true, value: geometry[key] });
  }
  Object.defineProperty(frame.contentWindow!, 'innerWidth', {
    configurable: true,
    value: geometry.innerWidth,
  });
  Object.defineProperty(frame.contentWindow!, 'innerHeight', {
    configurable: true,
    value: geometry.innerHeight,
  });
}

async function readPage(): Promise<string> {
  const r = await executeContentTool('read_page', {});
  return r.resultText;
}

function refOf(yaml: string, needle: string): string {
  const line = yaml.split('\n').find((l) => l.includes(needle));
  const m = line?.match(/\[ref=(s[a-z0-9]+_\d+_\d+)\]/i);
  if (!m) throw new Error(`no ref found for "${needle}" in:\n${yaml}`);
  return m[1]!;
}

describe('read_page / snapshot lifecycle', () => {
  it('produces a snapshot and bumps snapshotId per call', async () => {
    document.body.innerHTML = '<button>甲</button>';
    const s1 = await readPage();
    const s2 = await readPage();
    const id1 = Number(s1.match(/# Page Snapshot \(s[a-z0-9]+_(\d+)\)/i)![1]);
    const id2 = Number(s2.match(/# Page Snapshot \(s[a-z0-9]+_(\d+)\)/i)![1]);
    expect(id2).toBe(id1 + 1);
  });

  it('article mode extracts readable text', async () => {
    document.body.innerHTML =
      '<article><h1>标题</h1><p>正文内容甲乙丙。</p></article><nav>导航垃圾</nav>';
    const r = await executeContentTool('read_page', { mode: 'article' });
    expect(r.resultText).toContain('正文内容甲乙丙');
    expect(r.resultText).not.toContain('导航垃圾');
  });
});

describe('extract (borrowed from browser-use extract + browsercluster GNE)', () => {
  it('preserves links as markdown and strips chrome (nav/footer)', async () => {
    document.body.innerHTML =
      '<nav>导航垃圾</nav><article><h2>小标题</h2><p>看 <a href="/docs/x">这篇文档</a> 了解详情。</p></article><footer>页脚垃圾</footer>';
    const r = await executeContentTool('extract', {});
    expect(r.resultText).toContain('[这篇文档](');
    expect(r.resultText).toMatch(/\/docs\/x/); // relative href resolved to absolute
    expect(r.resultText).toContain('## 小标题');
    expect(r.resultText).not.toContain('导航垃圾');
    expect(r.resultText).not.toContain('页脚垃圾');
    // extract is read-only: no fresh snapshot on the result (write path only).
    expect(r.snapshot).toBeUndefined();
  });

  it("scope limits extraction to a ref'd subtree", async () => {
    document.body.innerHTML =
      '<main><button id="a">甲区块内容</button><section id="b"><p>乙区块内容</p></section></main>';
    // The button is the only ref'd element containing 甲区块内容; grab the ref
    // off that specific line (the aggregate <main> line carries no ref).
    const yaml = await readPage();
    const line = yaml.split('\n').find((l) => l.includes('甲区块内容') && /\[ref=/.test(l))!;
    const scope = line.match(/\[ref=(s[a-z0-9]+_\d+_\d+)\]/i)![1]!;
    const r = await executeContentTool('extract', { scope });
    expect(r.resultText).toContain('甲区块内容');
    expect(r.resultText).not.toContain('乙区块内容');
  });

  it('returns the FULL markdown (windowing is done engine-side, not here)', async () => {
    const long = '甲'.repeat(20_000);
    document.body.innerHTML = `<article><p>${long}</p></article>`;
    const r = await executeContentTool('extract', {});
    // Content-script layer returns everything up to the hard cap — no fromChar
    // windowing or continuation footer at this layer.
    expect(r.resultText.length).toBeGreaterThan(19_000);
    expect(r.resultText).not.toMatch(/fromChar/);
  });

  it('drops javascript: links (no markdown link emitted)', async () => {
    document.body.innerHTML =
      '<article><p><a href="javascript:steal()">点我</a> 安全文本</p></article>';
    const r = await executeContentTool('extract', {});
    expect(r.resultText).not.toContain('javascript:');
    expect(r.resultText).toContain('安全文本');
  });
});

describe('stale-ref rejection (docs/05 §1.1 — protocol-level expiry)', () => {
  it('rejects refs from an older snapshot with a re-read instruction', async () => {
    document.body.innerHTML = '<button>点我</button>';
    const yaml1 = await readPage();
    const oldRef = refOf(yaml1, '点我');
    await readPage(); // snapshot id advances → oldRef now stale
    await expect(executeContentTool('click', { ref: oldRef })).rejects.toThrow(
      /快照已过期.*read_page/s,
    );
  });

  it('rejects refs to disconnected elements', async () => {
    document.body.innerHTML = '<button id="b">点我</button>';
    const yaml = await readPage();
    const ref = refOf(yaml, '点我');
    document.getElementById('b')!.remove();
    await expect(executeContentTool('click', { ref })).rejects.toThrow(/快照已过期/);
  });

  it('rejects legacy refs and refs whose iframe document was replaced', async () => {
    document.body.innerHTML = '<iframe title="frame"></iframe>';
    const frame = document.querySelector('iframe')!;
    frame.contentDocument!.body.innerHTML = '<button>inside</button>';
    const ref = refOf(await readPage(), 'inside');
    const replacement = document.implementation.createHTMLDocument('replacement');
    replacement.body.innerHTML = '<button>inside</button>';
    Object.defineProperty(frame, 'contentDocument', {
      configurable: true,
      get: () => replacement,
    });

    await expect(executeContentTool('get_rect', { ref })).rejects.toMatchObject({
      failure: { code: 'stale_ref' },
    });
    await expect(executeContentTool('click', { ref: 's1_1' })).rejects.toMatchObject({
      failure: { code: 'stale_ref' },
    });
  });

  it('does not reuse a ref after pushState, rerender, and a fresh snapshot', async () => {
    document.body.innerHTML = '<button>before</button>';
    const oldRef = refOf(await readPage(), 'before');
    history.pushState({}, '', '/rerendered');
    document.body.innerHTML = '<button>after</button>';
    await readPage();

    await expect(executeContentTool('click', { ref: oldRef })).rejects.toMatchObject({
      failure: { code: 'stale_ref' },
    });
  });

  it('does not recover an old ref into a replacement iframe document with the same hint', async () => {
    document.body.innerHTML = '<iframe title="frame"></iframe>';
    const frame = document.querySelector('iframe')!;
    frame.contentDocument!.body.innerHTML = '<input aria-label="same target">';
    const original = frame.contentDocument!.querySelector('input')!;
    const oldRef = refOf(await readPage(), 'same target');
    const replacement = document.implementation.createHTMLDocument('replacement');
    replacement.body.innerHTML = '<input aria-label="same target">';
    const replacementInput = replacement.querySelector('input')!;
    const events: string[] = [];
    for (const input of [original, replacementInput]) {
      input.addEventListener('click', () => events.push('click'));
      input.addEventListener('input', () => events.push('input'));
    }
    Object.defineProperty(frame, 'contentDocument', {
      configurable: true,
      get: () => replacement,
    });
    await readPage();
    const runner = new ActionRunner({
      execute: (tool, params) => executeContentTool(tool, params),
    });

    await expect(runner.run('click', { ref: oldRef })).rejects.toMatchObject({
      failure: { code: 'stale_ref' },
    });
    expect(events).toEqual([]);
  });
});

describe('same-origin iframe geometry', () => {
  it('maps border, iframe scroll, top scroll, and axis scale into screenshot coordinates', async () => {
    document.body.innerHTML = '<iframe title="frame" style="transform:scale(1.25)"></iframe>';
    const frame = document.querySelector('iframe')!;
    frame.contentDocument!.body.innerHTML = '<button>inside</button>';
    const button = frame.contentDocument!.querySelector('button')!;
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(domRect(20, 30, 40, 10));
    setFrameGeometry(frame, {
      left: 100,
      top: 50,
      width: 275,
      height: 150,
      offsetWidth: 220,
      offsetHeight: 120,
      clientWidth: 200,
      clientHeight: 100,
      clientLeft: 10,
      clientTop: 10,
      innerWidth: 200,
      innerHeight: 100,
    });
    Object.defineProperty(window, 'scrollX', { configurable: true, value: 17 });
    Object.defineProperty(window, 'scrollY', { configurable: true, value: 23 });
    const ref = refOf(await readPage(), 'inside');

    await expect(
      executeContentTool('get_rect', { ref, coordinateSpace: 'viewport' }),
    ).resolves.toMatchObject({ rect: { x: 137.5, y: 100, width: 50, height: 12.5 } });
    await expect(
      executeContentTool('get_rect', { ref, coordinateSpace: 'document' }),
    ).resolves.toMatchObject({ rect: { x: 154.5, y: 123, width: 50, height: 12.5 } });

    const annotation = await executeContentTool('annotate_refs', {});
    expect(annotation.resultText).toContain(ref);
    const badge = document
      .querySelector('panelot-overlay')!
      .shadowRoot!.querySelector<HTMLElement>('#ref-annotations > div')!;
    expect(badge.style.left).toBe('137.5px');
    expect(badge.style.top).toBe('100px');
  });

  it('maps nested iframe border chains into the top viewport', async () => {
    document.body.innerHTML = '<iframe title="outer"></iframe>';
    const outer = document.querySelector('iframe')!;
    outer.contentDocument!.body.innerHTML = '<iframe title="inner"></iframe>';
    const inner = outer.contentDocument!.querySelector('iframe')!;
    inner.contentDocument!.body.innerHTML = '<button>nested</button>';
    const button = inner.contentDocument!.querySelector('button')!;
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(domRect(10, 10, 20, 10));
    setFrameGeometry(inner, {
      left: 30,
      top: 20,
      width: 120,
      height: 70,
      offsetWidth: 120,
      offsetHeight: 70,
      clientWidth: 110,
      clientHeight: 60,
      clientLeft: 5,
      clientTop: 5,
      innerWidth: 110,
      innerHeight: 60,
    });
    setFrameGeometry(outer, {
      left: 100,
      top: 50,
      width: 220,
      height: 120,
      offsetWidth: 220,
      offsetHeight: 120,
      clientWidth: 200,
      clientHeight: 100,
      clientLeft: 10,
      clientTop: 10,
      innerWidth: 200,
      innerHeight: 100,
    });
    const ref = refOf(await readPage(), 'nested');

    await expect(
      executeContentTool('get_rect', { ref, coordinateSpace: 'viewport' }),
    ).resolves.toMatchObject({ rect: { x: 155, y: 95, width: 20, height: 10 } });
  });

  it('fails closed for transforms that are not positive axis-aligned', async () => {
    document.body.innerHTML = '<iframe title="frame" style="transform:rotate(10deg)"></iframe>';
    const frame = document.querySelector('iframe')!;
    frame.contentDocument!.body.innerHTML = '<button>inside</button>';
    const button = frame.contentDocument!.querySelector('button')!;
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(domRect(10, 10, 20, 10));
    setFrameGeometry(frame, {
      left: 100,
      top: 50,
      width: 220,
      height: 120,
      offsetWidth: 220,
      offsetHeight: 120,
      clientWidth: 200,
      clientHeight: 100,
      clientLeft: 10,
      clientTop: 10,
      innerWidth: 200,
      innerHeight: 100,
    });
    const ref = refOf(await readPage(), 'inside');

    await expect(
      executeContentTool('get_rect', { ref, coordinateSpace: 'viewport' }),
    ).rejects.toMatchObject({ failure: { code: 'unsupported_frame' } });
  });
});

describe('click / type / select', () => {
  it('clicks through the full pointer event sequence', async () => {
    document.body.innerHTML = '<button id="b">提交</button>';
    const events: string[] = [];
    const btn = document.getElementById('b')!;
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      btn.addEventListener(t, () => events.push(t));
    }
    const ref = refOf(await readPage(), '提交');
    const result = await executeContentTool('click', { ref });
    expect(events).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
    expect(result.snapshot).toBeDefined(); // write actions return a fresh snapshot
  }, 15_000);

  it('types via native setter so frameworks see the change, with value verification', async () => {
    document.body.innerHTML = '<input aria-label="邮箱" type="text">';
    const input = document.querySelector('input')!;
    let inputEvents = 0;
    input.addEventListener('input', () => inputEvents++);
    const ref = refOf(await readPage(), '邮箱');
    await executeContentTool('type', { ref, text: 'a@b.com' });
    expect(input.value).toBe('a@b.com');
    expect(inputEvents).toBeGreaterThan(0);
  }, 15_000);

  it('type mode:append preserves existing value', async () => {
    document.body.innerHTML = '<input aria-label="搜索" value="hello">';
    const ref = refOf(await readPage(), '搜索');
    await executeContentTool('type', { ref, text: ' world', mode: 'append' });
    expect(document.querySelector('input')!.value).toBe('hello world');
  }, 15_000);

  it('does not mark a same-value type as verified', async () => {
    document.body.innerHTML = '<input aria-label="搜索" value="already there">';
    const ref = refOf(await readPage(), '搜索');

    const result = await executeContentTool('type', { ref, text: 'already there' });

    expect(result.resultText).toContain('原本已是目标值');
    expect(result.evidence).toMatchObject({
      effectState: 'dispatched',
      observedEffects: [],
      outcome: 'uncertain',
    });
  }, 15_000);

  it('rejects type when the page rolls the requested value back', async () => {
    document.body.innerHTML = '<input aria-label="受控输入" value="initial">';
    const input = document.querySelector('input')!;
    input.addEventListener('input', () => {
      input.value = 'page-owned';
    });
    const ref = refOf(await readPage(), '受控输入');

    await expect(
      executeContentTool('type', { ref, text: 'requested', slowly: true }),
    ).rejects.toThrow(/目标状态未能保持/);
    expect(input.value).toBe('page-owned');
  }, 15_000);

  it('select matches by value or text and errors with available options', async () => {
    document.body.innerHTML = `
      <select aria-label="城市">
        <option value="bj">北京</option>
        <option value="sh">上海</option>
      </select>`;
    const ref = refOf(await readPage(), '城市');
    await executeContentTool('select_option', { ref, values: ['上海'] });
    expect(document.querySelector('select')!.value).toBe('sh');

    const yaml2 = await readPage();
    const ref2 = refOf(yaml2, '城市');
    await expect(
      executeContentTool('select_option', { ref: ref2, values: ['广州'] }),
    ).rejects.toThrow(/可用选项.*北京/s);
  }, 20_000);

  it('does not mark a same-selection no-op as verified', async () => {
    document.body.innerHTML = `
      <select aria-label="城市">
        <option value="bj" selected>北京</option>
        <option value="sh">上海</option>
      </select>`;
    const ref = refOf(await readPage(), '城市');

    const result = await executeContentTool('select_option', { ref, values: ['北京'] });

    expect(result.resultText).toContain('原本已选择');
    expect(result.evidence).toMatchObject({
      effectState: 'dispatched',
      observedEffects: [],
      outcome: 'uncertain',
    });
  }, 15_000);

  it('rejects select when a page change handler restores the previous option', async () => {
    document.body.innerHTML = `
      <select aria-label="受控城市">
        <option value="bj" selected>北京</option>
        <option value="sh">上海</option>
      </select>`;
    const select = document.querySelector('select')!;
    select.value = 'bj';
    select.addEventListener('change', () => {
      select.value = 'bj';
    });
    const ref = refOf(await readPage(), '受控城市');
    expect(select.value).toBe('bj');

    await expect(executeContentTool('select_option', { ref, values: ['上海'] })).rejects.toThrow(
      /目标状态未能保持/,
    );
    expect(select.value).toBe('bj');
  }, 15_000);
});

describe('wait_for (docs/05 §3 three modes)', () => {
  it('resolves when text appears', async () => {
    document.body.innerHTML = '<div id="root">加载中</div>';
    setTimeout(() => {
      document.getElementById('root')!.textContent = '加载完成';
    }, 100);
    const r = await executeContentTool('wait_for', { text: '加载完成' });
    expect(r.resultText).toContain('已出现');
  });

  it('resolves when text disappears', async () => {
    document.body.innerHTML = '<div id="spinner">加载中</div>';
    setTimeout(() => document.getElementById('spinner')!.remove(), 100);
    const r = await executeContentTool('wait_for', { text: '加载中', textGone: true });
    expect(r.resultText).toContain('已消失');
  });

  it('waits fixed time with timeMs', async () => {
    const start = Date.now();
    await executeContentTool('wait_for', { timeMs: 150 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(140);
  });
});

describe('batch_actions (docs/05 §3 — change interruption)', () => {
  it('executes actions in order against a form', async () => {
    document.body.innerHTML = `
      <form>
        <input aria-label="姓名" type="text">
        <input aria-label="电话" type="text">
        <button type="button">提交</button>
      </form>`;
    const yaml = await readPage();
    const nameRef = refOf(yaml, '姓名');
    const phoneRef = refOf(yaml, '电话');
    const result = await executeContentTool('batch_actions', {
      actions: [
        { kind: 'type', params: { ref: nameRef, text: '张三' } },
        { kind: 'type', params: { ref: phoneRef, text: '13800138000' } },
      ],
    });
    expect(document.querySelectorAll('input')[0]!.value).toBe('张三');
    expect(document.querySelectorAll('input')[1]!.value).toBe('13800138000');
    expect(result.resultText).toContain('1. type');
    expect(result.resultText).toContain('2. type');
  }, 20_000);

  it('interrupts remaining actions when the DOM changes significantly', async () => {
    document.body.innerHTML = `
      <button id="mutator">变身按钮</button>
      <button id="other">另一个</button>`;
    // Clicking the first button replaces the page content.
    document.getElementById('mutator')!.addEventListener('click', () => {
      document.body.innerHTML = `<div>全新页面</div>${'<button>新按钮</button>'.repeat(10)}`;
    });
    const yaml = await readPage();
    const mutatorRef = refOf(yaml, '变身按钮');
    const otherRef = refOf(yaml, '另一个');
    const result = await executeContentTool('batch_actions', {
      actions: [
        { kind: 'click', params: { ref: mutatorRef } },
        { kind: 'click', params: { ref: otherRef } },
      ],
    });
    expect(result.resultText).toContain('中断剩余');
  }, 20_000);

  it('interrupts after a link that targets a new browsing context', async () => {
    document.body.innerHTML = `
      <a href="about:blank" target="_blank">打开详情</a>
      <button type="button">不应继续</button>`;
    let continued = false;
    document.querySelector('button')!.addEventListener('click', () => {
      continued = true;
    });
    const yaml = await readPage();
    const linkRef = refOf(yaml, '打开详情');
    const buttonRef = refOf(yaml, '不应继续');

    const result = await executeContentTool('batch_actions', {
      actions: [
        { kind: 'click', params: { ref: linkRef } },
        { kind: 'click', params: { ref: buttonRef } },
      ],
    });

    expect(result.resultText).toContain('打开新的浏览上下文，中断剩余 1 个动作');
    expect(continued).toBe(false);
  }, 20_000);

  it('interrupts after submitting a form that targets a new browsing context', async () => {
    document.body.innerHTML = `
      <form action="about:blank" target="_blank">
        <input aria-label="搜索" type="search">
      </form>
      <button type="button">不应继续</button>`;
    document.querySelector('form')!.addEventListener('submit', (event) => event.preventDefault());
    let continued = false;
    document.querySelector('button')!.addEventListener('click', () => {
      continued = true;
    });
    const yaml = await readPage();
    const inputRef = refOf(yaml, '搜索');
    const buttonRef = refOf(yaml, '不应继续');

    const result = await executeContentTool('batch_actions', {
      actions: [
        { kind: 'type', params: { ref: inputRef, text: 'Panelot', submit: true } },
        { kind: 'click', params: { ref: buttonRef } },
      ],
    });

    expect(result.resultText).toContain('打开新的浏览上下文，中断剩余 1 个动作');
    expect(continued).toBe(false);
  }, 20_000);
});

describe('empty-tree explicit failure (docs/05 §1.4 — no silent empty)', () => {
  it('throws EMPTY_TREE for a blank page so the fallback chain can trigger', async () => {
    document.body.innerHTML = '';
    await expect(executeContentTool('read_page', {})).rejects.toThrow(/EMPTY_TREE/);
  });
});

describe('upload op (DataTransfer synthesis — real file set, no CDP path needed)', () => {
  it('sets a File on the input and dispatches change', async () => {
    document.body.innerHTML = '<input type="file" aria-label="附件上传">';
    const yaml = await readPage();
    const ref = refOf(yaml, '附件上传');
    let changed = false;
    document.querySelector('input')!.addEventListener('change', () => {
      changed = true;
    });

    const result = await executeContentTool('upload', {
      ref,
      filename: 'report.txt',
      mime: 'text/plain',
      base64: btoa('hello panelot'),
    });
    expect(result.resultText).toContain('已选择文件 report.txt');
    const input = document.querySelector('input')!;
    expect(input.files).toHaveLength(1);
    expect(input.files![0]!.name).toBe('report.txt');
    expect(changed).toBe(true);
  }, 15_000);

  it('rejects non-file-input refs loudly', async () => {
    document.body.innerHTML = '<button>不是输入框</button>';
    const yaml = await readPage();
    const ref = refOf(yaml, '不是输入框');
    await expect(
      executeContentTool('upload', { ref, filename: 'x', mime: 'text/plain', base64: btoa('x') }),
    ).rejects.toThrow(/不是文件输入框/);
  });
});

describe('focus op (CDP press_key pre-step)', () => {
  it('focuses the target element', async () => {
    document.body.innerHTML = '<input placeholder="搜索">';
    const yaml = await readPage();
    const ref = refOf(yaml, '搜索');
    const result = await executeContentTool('focus', { ref });
    expect(result.resultText).toBe('已聚焦');
    expect(document.activeElement).toBe(document.querySelector('input'));
  });
});
