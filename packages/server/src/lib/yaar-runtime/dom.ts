/// <reference lib="dom" />

import { effect } from './reactivity.ts';

// ── DOM ─────────────────────────────────────────────────────────────────────

export type Child = string | number | boolean | null | undefined | Node | Child[] | (() => Child);

export type Props = Record<string, any> | null;

export function h(tag: string, props?: Props, ...children: Child[]): HTMLElement {
  // Parse tag: "div.foo.bar#baz" → tag=div, classes=[foo,bar], id=baz
  let tagName = tag;
  const classes: string[] = [];
  let id: string | undefined;

  const idIdx = tag.indexOf('#');
  const classIdx = tag.indexOf('.');
  const firstSpecial = Math.min(idIdx >= 0 ? idIdx : Infinity, classIdx >= 0 ? classIdx : Infinity);

  if (firstSpecial < Infinity) {
    tagName = tag.slice(0, firstSpecial) || 'div';
    const rest = tag.slice(firstSpecial);
    const parts = rest.split(/(?=[.#])/);
    for (const p of parts) {
      if (p[0] === '.') classes.push(p.slice(1));
      else if (p[0] === '#') id = p.slice(1);
    }
  }

  const el = document.createElement(tagName);
  if (id) el.id = id;
  if (classes.length) el.classList.add(...classes);

  if (props) {
    for (const [key, val] of Object.entries(props)) {
      if (key === 'className') {
        if (typeof val === 'function') {
          effect(() => {
            el.className = [classes.join(' '), val()].filter(Boolean).join(' ');
          });
        } else {
          if (classes.length) el.className = classes.join(' ') + ' ' + val;
          else el.className = val;
        }
      } else if (key === 'style') {
        if (typeof val === 'string') {
          el.style.cssText = val;
        } else if (typeof val === 'object') {
          for (const [sk, sv] of Object.entries(val as Record<string, any>)) {
            if (typeof sv === 'function') {
              effect(() => {
                (el.style as any)[sk] = sv();
              });
            } else {
              (el.style as any)[sk] = sv;
            }
          }
        }
      } else if (key === 'ref') {
        if (typeof val === 'function') val(el);
      } else if (key.startsWith('on')) {
        const event = key.slice(2).toLowerCase();
        el.addEventListener(event, val);
      } else if (typeof val === 'function' && !key.startsWith('on')) {
        effect(() => {
          const v = val();
          if (v == null || v === false) el.removeAttribute(key);
          else el.setAttribute(key, String(v));
        });
      } else {
        if (val == null || val === false) {
          /* skip */
        } else if (val === true) el.setAttribute(key, '');
        else el.setAttribute(key, String(val));
      }
    }
  }

  appendChildren(el, children);
  return el;
}

export function appendChildren(parent: Node, children: Child[]) {
  for (const child of children) {
    if (child == null || child === false || child === true) continue;
    if (Array.isArray(child)) {
      appendChildren(parent, child);
    } else if (typeof child === 'function') {
      // Use start/end comment markers to track the range of nodes produced
      // by this reactive expression. On re-render, everything between the
      // markers is removed before inserting the new content.
      const start = document.createComment('');
      const end = document.createComment('');
      parent.appendChild(start);
      parent.appendChild(end);
      effect(() => {
        const val = child();
        // Clear previous content between markers
        while (start.nextSibling && start.nextSibling !== end) {
          start.nextSibling.remove();
        }
        const node = toNode(val);
        // Insert new content before end marker
        end.parentNode!.insertBefore(node, end);
      });
    } else if (child instanceof Node) {
      parent.appendChild(child);
    } else {
      parent.appendChild(document.createTextNode(String(child)));
    }
  }
}

function toNode(val: Child): Node {
  if (val == null || val === false || val === true) return document.createTextNode('');
  if (val instanceof Node) return val;
  if (Array.isArray(val)) {
    const frag = document.createDocumentFragment();
    appendChildren(frag, val);
    return frag;
  }
  return document.createTextNode(String(val));
}

export function mount(element: Node, container?: HTMLElement): void {
  const target = container || document.getElementById('app');
  if (!target) throw new Error('Mount target not found');
  target.appendChild(element);
}
