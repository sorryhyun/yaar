/**
 * The provider-neutral shape of "something went wrong and the turn is still going".
 *
 * Both SDKs report trouble on far more channels than they report *fatal* trouble
 * on, and both were read for the fatal one alone. The per-provider vocabularies
 * live in `claude/errors.ts` and `codex/errors.ts`; what they have in common is
 * this: a level, the provider's own discriminant, and a sentence. Keeping the
 * shape here rather than in either provider is what lets `StreamToEventMapper`
 * handle one `notice` case instead of two.
 *
 * A notice is **never terminal**. `StreamMessage.type === 'error'` latches the
 * turn closed (`StreamToEventMapper.fail`) and stops the provider's read loop;
 * anything the provider will recover from must come through here instead, or the
 * UI reports a dead turn that is in fact still running.
 */

import type { StreamMessage } from './types.js';

export interface ProviderNotice {
  /**
   * Prominence only. `warning` is a real problem (a limit, a denial, a refusal,
   * a truncation); `info` is bookkeeping the user may want to find afterwards
   * but need not act on (an automatic model swap, a deprecation).
   */
  level: 'info' | 'warning';
  /**
   * The provider's own discriminant, forwarded verbatim so a consumer can key
   * off the failure without parsing English.
   */
  code: string;
  text: string;
}

/** Lift a notice onto the wire, carrying the session id along when there is one. */
export function toNoticeMessage(notice: ProviderNotice, sessionId?: string): StreamMessage {
  return {
    type: 'notice',
    content: notice.text,
    noticeLevel: notice.level,
    errorCode: notice.code,
    ...(sessionId ? { sessionId } : {}),
  };
}
