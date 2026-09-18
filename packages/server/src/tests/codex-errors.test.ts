import { describe, expect, it } from 'bun:test';
import { describeTurnError } from '../providers/codex/errors.js';

describe('describeTurnError', () => {
  it('names the rate-limit code added in codex 0.155', () => {
    const out = describeTurnError(
      {
        message: '',
        codexErrorInfo: 'rateLimitExceeded',
        additionalDetails: null,
        misalignment: null,
      },
      'Turn failed',
    );
    expect(out).toEqual({ text: 'The Codex API rate limit was hit.', code: 'rateLimitExceeded' });
  });

  it("surfaces a misalignment block's explanation but not its continuation steer", () => {
    const out = describeTurnError(
      {
        message: '',
        codexErrorInfo: 'misalignmentPolicyViolation',
        additionalDetails: null,
        misalignment: {
          errorType: 'x',
          detailedExplanation: 'Blocked because of X.',
          steer: { message: 'continue anyway' },
        },
      },
      'Turn failed',
    );
    expect(out.text).toContain('Blocked because of X.');
    expect(out.text).not.toContain('continue anyway');
    expect(out.code).toBe('misalignmentPolicyViolation');
  });
});
