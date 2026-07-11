// @vitest-environment happy-dom
/**
 * Snapshot perception through open shadow DOM and same-origin iframes —
 * modern component sites were entirely invisible before (walk used only
 * el.children), so the model "saw" pages that weren't there.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildSnapshot } from '../../src/tools/snapshot/engine';

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = 'Shadow Test';
});

const snap = () => buildSnapshot(window as unknown as Window, { snapshotId: 1 });

describe('open shadow DOM', () => {
  it('elements inside an open shadow root get refs', () => {
    const host = document.createElement('my-widget');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button>Shadow 按钮</button><input placeholder="shadow 输入">';
    document.body.appendChild(host);

    const result = snap();
    expect(result.yaml).toContain('button "Shadow 按钮" [ref=');
    expect(result.yaml).toContain('textbox "shadow 输入"');
    // The refs resolve to live elements inside the shadow root.
    const btnRef = [...result.refMap.entries()].find(([, el]) => el.textContent === 'Shadow 按钮');
    expect(btnRef).toBeDefined();
    expect(btnRef![1].isConnected).toBe(true);
  });

  it('slotted light-DOM children are reachable through the slot', () => {
    const host = document.createElement('my-card');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<div><slot></slot></div>';
    const lightButton = document.createElement('button');
    lightButton.textContent = '插槽按钮';
    host.appendChild(lightButton);
    document.body.appendChild(host);

    const result = snap();
    expect(result.yaml).toContain('button "插槽按钮" [ref=');
  });

  it('a custom element that is itself a control keeps its ref AND its shadow label', () => {
    // <my-button role=button> whose label lives only in shadow text — the
    // host must both get a ref (clickable) and surface the shadow content.
    const host = document.createElement('my-button');
    host.setAttribute('role', 'button');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<span>提交订单</span>';
    document.body.appendChild(host);

    const result = snap();
    // Host is interactive → has a ref.
    const hostRef = [...result.refMap.values()].find(
      (el) => el.tagName.toLowerCase() === 'my-button',
    );
    expect(hostRef).toBeDefined();
    // Shadow text is not lost.
    expect(result.yaml).toContain('提交订单');
  });

  it('closed shadow roots stay invisible without crashing', () => {
    const host = document.createElement('sealed-widget');
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<button>看不见</button>';
    document.body.appendChild(host);
    document.body.insertAdjacentHTML('beforeend', '<button>看得见</button>');

    const result = snap();
    expect(result.yaml).not.toContain('看不见');
    expect(result.yaml).toContain('button "看得见"');
  });
});

describe('iframes', () => {
  it('same-origin iframe content is walked recursively', () => {
    const iframe = document.createElement('iframe');
    iframe.title = '登录框';
    document.body.appendChild(iframe);
    iframe.contentDocument!.body.innerHTML =
      '<input type="password" placeholder="密码"><button>登录</button>';

    const result = snap();
    expect(result.yaml).toContain('iframe "登录框"');
    expect(result.yaml).toContain('button "登录" [ref=');
    expect(result.yaml).toContain('"密码"');
  });

  it('cross-origin iframes are announced as blind spots, not omitted', () => {
    const iframe = document.createElement('iframe');
    iframe.title = '第三方支付';
    document.body.appendChild(iframe);
    // Simulate the cross-origin SecurityError on contentDocument access.
    Object.defineProperty(iframe, 'contentDocument', {
      get() {
        throw new DOMException('Blocked a frame', 'SecurityError');
      },
    });

    const result = snap();
    expect(result.yaml).toContain('iframe "第三方支付"');
    expect(result.yaml).toContain('[跨域不可见]');
  });
});
