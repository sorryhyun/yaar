/// <reference lib="dom" />

import { h, appendChildren } from './dom.ts';
import type { Child, Props } from './dom.ts';

// ── HTML Tagged Template ────────────────────────────────────────────────────

const CACHE = new WeakMap<TemplateStringsArray, (fields: unknown[]) => Node>();

export function html(statics: TemplateStringsArray, ...fields: unknown[]): Node {
  let tpl = CACHE.get(statics);
  if (!tpl) {
    tpl = build(statics);
    CACHE.set(statics, tpl);
  }
  return tpl(fields);
}

const MODE_TEXT = 0;
const MODE_TAG_NAME = 1;
const MODE_ATTR_NAME = 2;
const MODE_ATTR_VALUE = 3;

type Op =
  | { t: 'open'; tag: string }
  | { t: 'close' }
  | { t: 'open_close'; tag: string }
  | { t: 'attr_static'; name: string; value: string }
  | { t: 'attr_field'; name: string; idx: number }
  | { t: 'text'; value: string }
  | { t: 'field'; idx: number }
  | { t: 'attr_spread'; idx: number };

function build(statics: TemplateStringsArray): (fields: unknown[]) => Node {
  const ops: Op[] = [];
  let mode = MODE_TEXT;
  let tagName = '';
  let attrName = '';
  let attrValue = '';
  let quote = '';
  let selfClosing = false;

  function commitTag(sc: boolean) {
    if (tagName) {
      ops.push(sc ? { t: 'open_close', tag: tagName } : { t: 'open', tag: tagName });
    }
    tagName = '';
    selfClosing = false;
  }

  function commitAttr() {
    if (attrName) {
      ops.push({ t: 'attr_static', name: attrName, value: attrValue || attrName });
      attrName = '';
      attrValue = '';
    }
  }

  for (let i = 0; i < statics.length; i++) {
    const s = statics[i];

    for (let j = 0; j < s.length; j++) {
      const ch = s[j];

      if (mode === MODE_TEXT) {
        if (ch === '<') {
          if (s[j + 1] === '/') {
            // Closing tag — skip to '>'
            const end = s.indexOf('>', j);
            if (end !== -1) {
              j = end;
              ops.push({ t: 'close' });
            }
          } else {
            mode = MODE_TAG_NAME;
            tagName = '';
            selfClosing = false;
          }
        } else {
          // Accumulate text
          let text = ch;
          while (j + 1 < s.length && s[j + 1] !== '<') {
            text += s[++j];
          }
          text = text.replace(/^\s+|\s+$/g, ' ');
          if (text && text !== ' ') ops.push({ t: 'text', value: text });
        }
      } else if (mode === MODE_TAG_NAME) {
        if (ch === '/' && tagName === '') {
          // </tag> — handled above, shouldn't reach here
        } else if (/\s/.test(ch)) {
          if (tagName) {
            // Emit 'open' immediately so attrs come AFTER the frame exists
            ops.push({ t: 'open', tag: tagName });
            tagName = '';
            mode = MODE_ATTR_NAME;
          }
        } else if (ch === '>') {
          commitTag(selfClosing);
          mode = MODE_TEXT;
        } else if (ch === '/') {
          selfClosing = true;
        } else {
          tagName += ch;
        }
      } else if (mode === MODE_ATTR_NAME) {
        if (ch === '=') {
          mode = MODE_ATTR_VALUE;
          attrValue = '';
          quote = '';
        } else if (ch === '/' || ch === '>') {
          commitAttr();
          if (ch === '>') {
            if (selfClosing) {
              ops.push({ t: 'close' });
              selfClosing = false;
            }
            mode = MODE_TEXT;
          } else {
            selfClosing = true;
          }
        } else if (/\s/.test(ch)) {
          if (attrName) commitAttr();
        } else {
          attrName += ch;
        }
      } else if (mode === MODE_ATTR_VALUE) {
        if (!quote && (ch === '"' || ch === "'")) {
          quote = ch;
        } else if (!quote && /\s/.test(ch)) {
          commitAttr();
          mode = MODE_ATTR_NAME;
        } else if (ch === quote) {
          commitAttr();
          mode = MODE_ATTR_NAME;
          quote = '';
        } else if (!quote && (ch === '>' || ch === '/')) {
          commitAttr();
          if (ch === '>') {
            if (selfClosing) {
              ops.push({ t: 'close' });
              selfClosing = false;
            }
            mode = MODE_TEXT;
          } else {
            selfClosing = true;
          }
        } else {
          attrValue += ch;
        }
      }
    }

    // Insert field between statics[i] and statics[i+1]
    if (i < statics.length - 1) {
      if (mode === MODE_TEXT) {
        ops.push({ t: 'field', idx: i });
      } else if (mode === MODE_ATTR_VALUE) {
        // name=${val} or name="${val}" — field is the attribute value
        const name = attrName;
        attrName = '';
        attrValue = '';
        quote = '';
        ops.push({ t: 'attr_field', name, idx: i });
        mode = MODE_ATTR_NAME;
      } else if (mode === MODE_ATTR_NAME) {
        if (attrName) {
          // Bare name followed by field — treat name as boolean, field as next attr
          ops.push({ t: 'attr_static', name: attrName, value: attrName });
          attrName = '';
          ops.push({ t: 'attr_spread', idx: i });
        } else {
          // ...${spread}
          ops.push({ t: 'attr_spread', idx: i });
        }
      }
    }
  }

  return (fields: unknown[]) => evaluate(ops, fields);
}

const ATTR_MAP: Record<string, string> = { class: 'className', for: 'htmlFor' };
function attrKey(name: string) {
  return ATTR_MAP[name] || name;
}

type Frame = { tag: string; children: Child[]; props: Record<string, unknown> };

function evaluate(ops: Op[], fields: unknown[]): Node {
  const stack: Frame[] = [];
  const root: Child[] = [];

  function addChild(child: Child) {
    if (stack.length) stack[stack.length - 1].children.push(child);
    else root.push(child);
  }

  for (const op of ops) {
    switch (op.t) {
      case 'open':
        stack.push({ tag: op.tag, children: [], props: {} });
        break;
      case 'open_close':
        addChild(h(op.tag, null));
        break;
      case 'close': {
        const frame = stack.pop();
        if (frame) {
          const props = Object.keys(frame.props).length ? frame.props : undefined;
          addChild(h(frame.tag, props as Props, ...frame.children));
        }
        break;
      }
      case 'attr_static': {
        const f = stack[stack.length - 1];
        if (f) f.props[attrKey(op.name)] = op.value;
        break;
      }
      case 'attr_field': {
        const f = stack[stack.length - 1];
        if (f) f.props[attrKey(op.name)] = fields[op.idx];
        break;
      }
      case 'attr_spread': {
        const f = stack[stack.length - 1];
        const spread = fields[op.idx];
        if (f && spread && typeof spread === 'object') Object.assign(f.props, spread);
        break;
      }
      case 'text':
        addChild(op.value);
        break;
      case 'field': {
        const val = fields[op.idx];
        if (Array.isArray(val)) for (const v of val) addChild(v as Child);
        else addChild(val as Child);
        break;
      }
    }
  }

  if (root.length === 1 && root[0] instanceof Node) return root[0];
  const frag = document.createDocumentFragment();
  appendChildren(frag, root);
  return frag;
}
