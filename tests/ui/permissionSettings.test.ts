// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLang, t } from '../../src/ui/i18n';
import {
  DEFAULT_PERMISSION_POLICIES,
  PermissionsPage,
} from '../../src/ui/settings/PermissionsPage';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  setLang('zh-CN');
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setLang('en');
});

describe('permission settings', () => {
  it('shows only the default policy titles without their descriptions', async () => {
    await act(async () => {
      root.render(createElement(PermissionsPage));
      await Promise.resolve();
    });

    for (const policy of DEFAULT_PERMISSION_POLICIES) {
      expect(container.textContent).toContain(t(`settings.permissions.policy.${policy}.label`));
      expect(container.textContent).not.toContain(t(`settings.permissions.policy.${policy}.desc`));
    }
  });
});
