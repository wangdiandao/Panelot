// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { executeContentTool } from '../../src/tools/content/executor';

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = 'Fixture';
});

async function readPage(): Promise<string> {
  const r = await executeContentTool('read_page', {});
  return r.resultText;
}

function refOf(yaml: string, needle: string): string {
  const line = yaml.split('\n').find((l) => l.includes(needle));
  const m = line?.match(/\[ref=(s\d+_\d+)\]/);
  if (!m) throw new Error(`no ref found for "${needle}" in:\n${yaml}`);
  return m[1]!;
}

describe('read_page / snapshot lifecycle', () => {
  it('produces a snapshot and bumps snapshotId per call', async () => {
    document.body.innerHTML = '<button>甲</button>';
    const s1 = await readPage();
    const s2 = await readPage();
    const id1 = Number(s1.match(/# Page Snapshot \(s(\d+)\)/)![1]);
    const id2 = Number(s2.match(/# Page Snapshot \(s(\d+)\)/)![1]);
    expect(id2).toBe(id1 + 1);
  });

  it('article mode extracts readable text', async () => {
    document.body.innerHTML = '<article><h1>标题</h1><p>正文内容甲乙丙。</p></article><nav>导航垃圾</nav>';
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

  it('scope limits extraction to a ref\'d subtree', async () => {
    document.body.innerHTML =
      '<main><button id="a">甲区块内容</button><section id="b"><p>乙区块内容</p></section></main>';
    // The button is the only ref'd element containing 甲区块内容; grab the ref
    // off that specific line (the aggregate <main> line carries no ref).
    const yaml = await readPage();
    const line = yaml.split('\n').find((l) => l.includes('甲区块内容') && /\[ref=/.test(l))!;
    const scope = line.match(/\[ref=(s\d+_\d+)\]/)![1]!;
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
    document.body.innerHTML = '<article><p><a href="javascript:steal()">点我</a> 安全文本</p></article>';
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
    await expect(executeContentTool('click', { ref: oldRef })).rejects.toThrow(/快照已过期.*read_page/s);
  });

  it('rejects refs to disconnected elements', async () => {
    document.body.innerHTML = '<button id="b">点我</button>';
    const yaml = await readPage();
    const ref = refOf(yaml, '点我');
    document.getElementById('b')!.remove();
    await expect(executeContentTool('click', { ref })).rejects.toThrow(/快照已过期/);
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
    await expect(executeContentTool('select_option', { ref: ref2, values: ['广州'] })).rejects.toThrow(/可用选项.*北京/s);
  }, 20_000);
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
