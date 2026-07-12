// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureActionable, type ActionabilityKind } from '../../src/tools/content/actionability';

interface Scenario {
  name: string;
  html: string;
  selector: string;
  kind: ActionabilityKind;
  code?: string;
}

const scenarios: Scenario[] = [
  { name: 'button', html: '<button>Save</button>', selector: 'button', kind: 'click' },
  { name: 'link', html: '<a href="#">Open</a>', selector: 'a', kind: 'click' },
  { name: 'text input', html: '<input>', selector: 'input', kind: 'type' },
  { name: 'textarea', html: '<textarea></textarea>', selector: 'textarea', kind: 'type' },
  {
    name: 'contenteditable',
    html: '<div contenteditable="true"></div>',
    selector: 'div',
    kind: 'type',
  },
  {
    name: 'select',
    html: '<select><option>A</option></select>',
    selector: 'select',
    kind: 'select',
  },
  {
    name: 'disabled button',
    html: '<button disabled>Save</button>',
    selector: 'button',
    kind: 'click',
    code: 'disabled',
  },
  {
    name: 'aria disabled',
    html: '<button aria-disabled="true">Save</button>',
    selector: 'button',
    kind: 'click',
    code: 'disabled',
  },
  {
    name: 'inert subtree',
    html: '<main inert><button>Save</button></main>',
    selector: 'button',
    kind: 'click',
    code: 'disabled',
  },
  {
    name: 'readonly input',
    html: '<input readonly>',
    selector: 'input',
    kind: 'type',
    code: 'not_editable',
  },
  {
    name: 'disabled input',
    html: '<input disabled>',
    selector: 'input',
    kind: 'type',
    code: 'disabled',
  },
  {
    name: 'button is not editable',
    html: '<button>Text</button>',
    selector: 'button',
    kind: 'type',
    code: 'not_editable',
  },
  {
    name: 'input is not select',
    html: '<input>',
    selector: 'input',
    kind: 'select',
    code: 'not_editable',
  },
  {
    name: 'display none',
    html: '<button style="display:none">Save</button>',
    selector: 'button',
    kind: 'click',
    code: 'not_visible',
  },
  {
    name: 'visibility hidden',
    html: '<button style="visibility:hidden">Save</button>',
    selector: 'button',
    kind: 'click',
    code: 'not_visible',
  },
  { name: 'checkbox click', html: '<input type="checkbox">', selector: 'input', kind: 'click' },
  { name: 'radio click', html: '<input type="radio">', selector: 'input', kind: 'click' },
  {
    name: 'summary click',
    html: '<details><summary>More</summary></details>',
    selector: 'summary',
    kind: 'click',
  },
  {
    name: 'role button',
    html: '<div role="button" tabindex="0">Go</div>',
    selector: 'div',
    kind: 'click',
  },
  { name: 'search input', html: '<input type="search">', selector: 'input', kind: 'type' },
];

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('20-scenario deterministic actionability matrix', () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      document.body.innerHTML = scenario.html;
      const element = document.querySelector(scenario.selector)!;
      if (scenario.code) {
        await expect(ensureActionable(element, scenario.kind)).rejects.toMatchObject({
          failure: { code: scenario.code },
        });
      } else {
        await expect(ensureActionable(element, scenario.kind)).resolves.toBeUndefined();
      }
    });
  }
});
