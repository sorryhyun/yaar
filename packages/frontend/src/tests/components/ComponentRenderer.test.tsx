/**
 * ComponentRenderer — every AI-generated interactive UI (buttons, forms, badges,
 * progress bars, images) goes through this flat Component-DSL renderer. Covers the
 * grid layout, every leaf type, enum normalization on bad input, and the button ->
 * onComponentAction dispatch (plain and form-submitting) that is the only way a
 * component reaches back out to the agent.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentLayout } from '@yaar/shared';

import { ComponentRenderer } from '@/components/window/renderers/ComponentRenderer';
import { WindowCallbackProvider, type WindowCallbacks } from '@/contexts/WindowCallbackContext';

function noopCallbacks(onComponentAction: WindowCallbacks['onComponentAction']): WindowCallbacks {
  return {
    onRenderSuccess: () => {},
    onRenderError: () => {},
    onComponentAction,
  };
}

function renderLayout(layout: unknown, onComponentAction: WindowCallbacks['onComponentAction']) {
  return render(
    <WindowCallbackProvider callbacks={noopCallbacks(onComponentAction)}>
      <ComponentRenderer data={layout} />
    </WindowCallbackProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe('ComponentRenderer entry point', () => {
  it('renders nothing when data has no components array', () => {
    const { container } = renderLayout({ cols: 2 }, () => {});
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when data is not an object at all', () => {
    const { container } = renderLayout('not a layout', () => {});
    expect(container.firstChild).toBeNull();
  });

  it('lays out an empty component list as an empty grid, still applying cols/gap', () => {
    const layout: ComponentLayout = { components: [], cols: [8, 2], gap: 'lg' };
    const { container } = renderLayout(layout, () => {});
    const grid = container.firstChild as HTMLElement;
    expect(grid).not.toBeNull();
    expect(grid.style.gridTemplateColumns).toBe('8fr 2fr');
    expect(grid.style.gap).toBe('var(--space-4)');
  });

  it('defaults to a single column and md gap when cols/gap are absent', () => {
    const layout: ComponentLayout = { components: [{ type: 'text', content: 'hi' }] };
    const { container } = renderLayout(layout, () => {});
    const grid = container.firstChild as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe('1fr');
    expect(grid.style.gap).toBe('var(--space-2)');
  });

  it('falls back to md gap for an unrecognized gap value', () => {
    const layout = { components: [], gap: 'huge' } as unknown as ComponentLayout;
    const { container } = renderLayout(layout, () => {});
    const grid = container.firstChild as HTMLElement;
    expect(grid.style.gap).toBe('var(--space-2)');
  });

  it('renders a numeric cols as repeat(n, 1fr)', () => {
    const layout: ComponentLayout = { components: [], cols: 3 };
    const { container } = renderLayout(layout, () => {});
    const grid = container.firstChild as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe('repeat(3, 1fr)');
  });

  it('renders an unsupported component type as a labeled fallback instead of crashing', () => {
    const layout = {
      components: [{ type: 'carousel', foo: 'bar' }],
    } as unknown as ComponentLayout;
    renderLayout(layout, () => {});
    expect(screen.getByText('unsupported: carousel')).toBeTruthy();
  });

  it('skips a malformed node (no type field) instead of crashing', () => {
    const layout = {
      components: [{ label: 'no type here' }, { type: 'text', content: 'still renders' }],
    } as unknown as ComponentLayout;
    renderLayout(layout, () => {});
    expect(screen.getByText('still renders')).toBeTruthy();
    expect(screen.queryByText('no type here')).toBeNull();
  });
});

describe('button component', () => {
  it('dispatches onAction with the label recorded as the component path, parallel by default', () => {
    let received: unknown[] = [];
    const layout: ComponentLayout = {
      components: [{ type: 'button', label: 'Go', action: 'do_thing' }],
    };
    renderLayout(layout, (...args) => {
      received = args;
    });

    fireEvent.click(screen.getByText('Go'));

    expect(received).toEqual(['do_thing', true, undefined, undefined, ['Button:Go']]);
  });

  it('respects parallel: false', () => {
    let received: unknown[] = [];
    const layout: ComponentLayout = {
      components: [{ type: 'button', label: 'Go', action: 'do_thing', parallel: false }],
    };
    renderLayout(layout, (...args) => {
      received = args;
    });

    fireEvent.click(screen.getByText('Go'));

    expect(received[1]).toBe(false);
  });

  it('does not fire onAction when disabled', () => {
    let calls = 0;
    const layout: ComponentLayout = {
      components: [{ type: 'button', label: 'Go', action: 'do_thing', disabled: true }],
    };
    renderLayout(layout, () => {
      calls += 1;
    });

    fireEvent.click(screen.getByText('Go'));
    expect(calls).toBe(0);
    expect((screen.getByText('Go').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enters a cooldown after one click and ignores a second immediate click', () => {
    let calls = 0;
    const layout: ComponentLayout = {
      components: [{ type: 'button', label: 'Go', action: 'do_thing' }],
    };
    renderLayout(layout, () => {
      calls += 1;
    });

    const button = screen.getByText('Go').closest('button') as HTMLButtonElement;
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(calls).toBe(1);
  });

  it('renders the icon alongside the label when provided', () => {
    const layout: ComponentLayout = {
      components: [{ type: 'button', label: 'Save', action: 'save', icon: '💾' }],
    };
    renderLayout(layout, () => {});
    expect(screen.getByText('💾')).toBeTruthy();
    expect(screen.getByText('Save')).toBeTruthy();
  });
});

describe('form submission through a button', () => {
  it('collects input and select values into formData keyed by field name, tagged with formId', () => {
    let received: unknown[] = [];
    const layout: ComponentLayout = {
      components: [
        { type: 'input', name: 'title', formId: 'f1', defaultValue: 'default title' },
        {
          type: 'select',
          name: 'kind',
          formId: 'f1',
          defaultValue: 'a',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ],
        },
        { type: 'button', label: 'Submit', action: 'submit_it', submitForm: 'f1' },
      ],
    };
    renderLayout(layout, (...args) => {
      received = args;
    });

    const input = screen.getByDisplayValue('default title') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'new title' } });

    const select = screen.getByDisplayValue('A') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'b' } });

    fireEvent.click(screen.getByText('Submit'));

    expect(received[0]).toBe('submit_it');
    expect(received[2]).toEqual({ title: 'new title', kind: 'b' });
    expect(received[3]).toBe('f1');
  });

  it('coerces a number-variant input to a numeric value in form data', () => {
    let received: unknown[] = [];
    const layout: ComponentLayout = {
      components: [
        { type: 'input', name: 'qty', formId: 'f1', variant: 'number', defaultValue: '1' },
        { type: 'button', label: 'Submit', action: 'submit_it', submitForm: 'f1' },
      ],
    };
    renderLayout(layout, (...args) => {
      received = args;
    });

    const input = screen.getByDisplayValue('1') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '42' } });
    fireEvent.click(screen.getByText('Submit'));

    expect(received[2]).toEqual({ qty: 42 });
  });

  it('sends no formData when the button has no submitForm, even with forms present', () => {
    let received: unknown[] = [];
    const layout: ComponentLayout = {
      components: [
        { type: 'input', name: 'title', formId: 'f1', defaultValue: 'x' },
        { type: 'button', label: 'Just go', action: 'go' },
      ],
    };
    renderLayout(layout, (...args) => {
      received = args;
    });

    fireEvent.click(screen.getByText('Just go'));

    expect(received).toEqual(['go', true, undefined, undefined, ['Button:Just go']]);
  });
});

describe('text component', () => {
  it('renders its content and falls back to defaults for an invalid variant/color/align', () => {
    const layout = {
      components: [
        { type: 'text', content: 'Hello', variant: 'nonsense', color: 42, textAlign: 'diagonal' },
      ],
    } as unknown as ComponentLayout;
    renderLayout(layout, () => {});
    expect(screen.getByText('Hello')).toBeTruthy();
  });
});

describe('badge component', () => {
  it('renders its label', () => {
    const layout: ComponentLayout = {
      components: [{ type: 'badge', label: 'New', variant: 'success' }],
    };
    renderLayout(layout, () => {});
    expect(screen.getByText('New')).toBeTruthy();
  });
});

describe('progress component', () => {
  it('clamps a value above 100 down to 100', () => {
    const layout: ComponentLayout = {
      components: [{ type: 'progress', value: 150, showValue: true }],
    };
    renderLayout(layout, () => {});
    expect(screen.getByText('100%')).toBeTruthy();
  });

  it('clamps a negative value up to 0', () => {
    const layout: ComponentLayout = {
      components: [{ type: 'progress', value: -20, showValue: true }],
    };
    renderLayout(layout, () => {});
    expect(screen.getByText('0%')).toBeTruthy();
  });

  it('treats a non-numeric value as 0', () => {
    const layout = {
      components: [{ type: 'progress', value: 'not a number', showValue: true }],
    } as unknown as ComponentLayout;
    renderLayout(layout, () => {});
    expect(screen.getByText('0%')).toBeTruthy();
  });

  it('shows the optional label and hides the percentage when showValue is unset', () => {
    const layout: ComponentLayout = {
      components: [{ type: 'progress', value: 40, label: 'Uploading' }],
    };
    renderLayout(layout, () => {});
    expect(screen.getByText('Uploading')).toBeTruthy();
    expect(screen.queryByText('40%')).toBeNull();
  });
});

describe('image component', () => {
  it('resolves a plain relative src unchanged in local mode and forwards width/height', () => {
    const layout: ComponentLayout = {
      components: [{ type: 'image', src: '/api/storage/pic.png', width: 100, height: 50 }],
    };
    const { container } = renderLayout(layout, () => {});
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/storage/pic.png');
    expect(img.style.width).toBe('100px');
    expect(img.style.height).toBe('50px');
  });
});

describe('input component', () => {
  it('renders a textarea when rows is set, and a text input otherwise', () => {
    const layout: ComponentLayout = {
      components: [
        { type: 'input', name: 'multi', label: 'Notes', rows: 4 },
        { type: 'input', name: 'single', label: 'Title' },
      ],
    };
    const { container } = renderLayout(layout, () => {});
    expect(container.querySelectorAll('textarea').length).toBe(1);
    expect(container.querySelectorAll('input').length).toBe(1);
  });

  it('shows its label and placeholder', () => {
    const layout: ComponentLayout = {
      components: [{ type: 'input', name: 'title', label: 'Title', placeholder: 'Enter a title' }],
    };
    renderLayout(layout, () => {});
    expect(screen.getByText('Title')).toBeTruthy();
    expect(screen.getByPlaceholderText('Enter a title')).toBeTruthy();
  });
});

describe('select component', () => {
  it('renders a disabled placeholder option plus every provided option', () => {
    const layout: ComponentLayout = {
      components: [
        {
          type: 'select',
          name: 'kind',
          placeholder: 'Choose one',
          options: [
            { value: 'a', label: 'A' },
            { value: 'b', label: 'B' },
          ],
        },
      ],
    };
    const { container } = renderLayout(layout, () => {});
    const select = container.querySelector('select') as HTMLSelectElement;
    const options = Array.from(select.querySelectorAll('option'));
    expect(options.map((o) => o.textContent)).toEqual(['Choose one', 'A', 'B']);
    expect((options[0] as HTMLOptionElement).disabled).toBe(true);
  });
});
