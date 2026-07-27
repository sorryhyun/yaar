import { describe, it, expect } from 'bun:test';
import { isWindowContentData, isContentUpdateOperationValid } from '../actions.js';

// The per-renderer shape guards (table / iframe / component) are module-internal; they are
// exercised here through `isWindowContentData`, the one exported entry point that dispatches
// to them.
describe('Runtime Validation', () => {
  describe('table content shape', () => {
    it('accepts valid table data', () => {
      expect(isWindowContentData('table', { headers: ['A', 'B'], rows: [['1', '2']] })).toBe(true);
    });

    it('accepts empty table', () => {
      expect(isWindowContentData('table', { headers: [], rows: [] })).toBe(true);
    });

    it('rejects invalid inputs', () => {
      expect(isWindowContentData('table', null)).toBe(false);
      expect(isWindowContentData('table', 'string')).toBe(false);
      expect(isWindowContentData('table', { headers: [1], rows: [] })).toBe(false);
      expect(isWindowContentData('table', { headers: [], rows: [[1]] })).toBe(false);
    });
  });

  describe('iframe content shape', () => {
    it('accepts string URL', () => {
      expect(isWindowContentData('iframe', 'https://example.com')).toBe(true);
    });

    it('accepts object with url', () => {
      expect(isWindowContentData('iframe', { url: 'https://example.com' })).toBe(true);
      expect(
        isWindowContentData('iframe', { url: 'https://example.com', sandbox: 'allow-scripts' }),
      ).toBe(true);
    });

    it('rejects invalid inputs', () => {
      expect(isWindowContentData('iframe', null)).toBe(false);
      expect(isWindowContentData('iframe', 42)).toBe(false);
      expect(isWindowContentData('iframe', { url: 123 })).toBe(false);
    });
  });

  describe('component layout shape', () => {
    it('accepts valid layout', () => {
      expect(isWindowContentData('component', { components: [] })).toBe(true);
      expect(isWindowContentData('component', { components: [{ type: 'button' }] })).toBe(true);
    });

    it('rejects invalid inputs', () => {
      expect(isWindowContentData('component', null)).toBe(false);
      expect(isWindowContentData('component', {})).toBe(false);
      expect(isWindowContentData('component', { components: 'not-array' })).toBe(false);
    });
  });

  describe('isWindowContentData', () => {
    it('validates string renderers', () => {
      expect(isWindowContentData('markdown', '# Hello')).toBe(true);
      expect(isWindowContentData('html', '<p>Hi</p>')).toBe(true);
      expect(isWindowContentData('text', 'plain')).toBe(true);
      expect(isWindowContentData('markdown', 42)).toBe(false);
    });

    it('validates table renderer', () => {
      expect(isWindowContentData('table', { headers: ['A'], rows: [['1']] })).toBe(true);
      expect(isWindowContentData('table', 'not-table')).toBe(false);
    });

    it('validates iframe renderer', () => {
      expect(isWindowContentData('iframe', 'https://example.com')).toBe(true);
      expect(isWindowContentData('iframe', null)).toBe(false);
    });

    it('validates component renderer', () => {
      expect(isWindowContentData('component', { components: [] })).toBe(true);
      expect(isWindowContentData('component', 'string')).toBe(false);
    });

    it('unknown renderer accepts anything defined', () => {
      expect(isWindowContentData('custom', 'anything')).toBe(true);
      expect(isWindowContentData('custom', undefined)).toBe(false);
    });
  });

  describe('isContentUpdateOperationValid', () => {
    it('validates append/prepend for text renderers', () => {
      expect(isContentUpdateOperationValid('markdown', { op: 'append', data: 'more' })).toBe(true);
      expect(isContentUpdateOperationValid('html', { op: 'prepend', data: '<p>' })).toBe(true);
      expect(isContentUpdateOperationValid('table', { op: 'append', data: 'nope' })).toBe(false);
      expect(isContentUpdateOperationValid('markdown', { op: 'append', data: 42 })).toBe(false);
    });

    it('validates insertAt', () => {
      expect(
        isContentUpdateOperationValid('text', { op: 'insertAt', position: 5, data: 'x' }),
      ).toBe(true);
      expect(
        isContentUpdateOperationValid('text', { op: 'insertAt', position: Infinity, data: 'x' }),
      ).toBe(false);
    });

    it('validates replace', () => {
      expect(isContentUpdateOperationValid('markdown', { op: 'replace', data: 'new' })).toBe(true);
      expect(
        isContentUpdateOperationValid('table', { op: 'replace', data: { headers: [], rows: [] } }),
      ).toBe(true);
    });

    it('clear always valid', () => {
      expect(isContentUpdateOperationValid('markdown', { op: 'clear' })).toBe(true);
      expect(isContentUpdateOperationValid('table', { op: 'clear' })).toBe(true);
    });
  });
});
