/**
 * UserPrompt — renders ask/request prompts from the agent.
 *
 * - Options mode (ask): shows selectable options with optional freeform text.
 * - Input mode (request): shows a text input for the user to provide a response.
 * - Both can coexist in a single prompt.
 */
import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useDesktopStore, selectUserPrompts } from '@/store';
import { useShallow } from 'zustand/react/shallow';
import { useAgentConnection } from '@/hooks/useAgentConnection';
import type { UserPromptModel } from '@/types/state';
import { isComposingKey } from '@/lib/ime';
import styles from '@/styles/overlays/UserPrompt.module.css';

function PromptBox({
  prompt,
  askedBy,
  onSubmit,
  onDismiss,
}: {
  prompt: UserPromptModel;
  /** Label of the monitor whose agent asked, when that is not the one on screen. */
  askedBy: string | null;
  onSubmit: (prompt: UserPromptModel, selectedValues?: string[], text?: string) => void;
  onDismiss: (prompt: UserPromptModel) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [text, setText] = useState('');

  const hasOptions = prompt.options && prompt.options.length > 0;
  const hasInput = !!prompt.inputField;

  const toggleOption = useCallback(
    (value: string) => {
      setSelected((prev) => {
        const next = new Set(prev);
        if (prompt.multiSelect) {
          if (next.has(value)) next.delete(value);
          else next.add(value);
        } else {
          if (next.has(value)) next.clear();
          else {
            next.clear();
            next.add(value);
          }
        }
        return next;
      });
    },
    [prompt.multiSelect],
  );

  const canSubmit = hasOptions
    ? selected.size > 0 || text.trim().length > 0
    : text.trim().length > 0;

  const handleSubmit = () => {
    const selectedValues = selected.size > 0 ? Array.from(selected) : undefined;
    const inputText = text.trim() || undefined;
    onSubmit(prompt, selectedValues, inputText);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (isComposingKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && canSubmit) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className={styles.prompt}>
      {/* Who is asking. A prompt reaches every monitor, so one raised by an agent the user
          is not watching used to be indistinguishable from one raised by the desktop in
          front of them — and answering it sent that agent off to open windows elsewhere. */}
      {askedBy && (
        <div className={styles.askedBy}>{t('userPrompt.askedBy', { monitor: askedBy })}</div>
      )}
      <div className={styles.title}>{prompt.title}</div>
      <div className={styles.message}>{prompt.message}</div>

      {hasOptions && (
        <div className={styles.options}>
          {prompt.options!.map((opt) => (
            // A <label> so the whole row activates the one control inside it. The row
            // used to carry its own onClick alongside the input's onChange, so a click
            // that landed on the input ran toggleOption twice and cancelled itself out.
            <label
              key={opt.value}
              className={styles.option}
              data-selected={selected.has(opt.value)}
            >
              <input
                type={prompt.multiSelect ? 'checkbox' : 'radio'}
                className={styles.optionRadio}
                checked={selected.has(opt.value)}
                // onClick, not onChange: a radio that is already checked fires no
                // change event, and single-select here allows clicking again to
                // deselect. Keyboard activation dispatches a click too, so this
                // covers Space/Enter on the focused input.
                onClick={() => toggleOption(opt.value)}
                onChange={() => {}}
                name={`prompt-${prompt.id}`}
              />
              <div className={styles.optionContent}>
                <span className={styles.optionLabel}>{opt.label}</span>
                {opt.description && (
                  <span className={styles.optionDescription}>{opt.description}</span>
                )}
              </div>
            </label>
          ))}
        </div>
      )}

      {hasInput && (
        <div className={styles.inputGroup}>
          {prompt.inputField!.label && (
            <label className={styles.inputLabel}>{prompt.inputField!.label}</label>
          )}
          {prompt.inputField!.type === 'textarea' ? (
            <textarea
              className={styles.textArea}
              placeholder={prompt.inputField!.placeholder}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={4}
              autoFocus
            />
          ) : (
            <input
              type={prompt.inputField!.type === 'password' ? 'password' : 'text'}
              className={styles.textInput}
              placeholder={prompt.inputField!.placeholder}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
            />
          )}
        </div>
      )}

      <div className={styles.buttons}>
        {prompt.allowDismiss !== false && (
          <button className={styles.dismissButton} onClick={() => onDismiss(prompt)}>
            {t('userPrompt.skip')}
          </button>
        )}
        <button className={styles.submitButton} disabled={!canSubmit} onClick={handleSubmit}>
          {t('userPrompt.submit')}
        </button>
      </div>
    </div>
  );
}

export function UserPrompt() {
  const prompts = useDesktopStore(useShallow(selectUserPrompts)) as UserPromptModel[];
  const dismissUserPrompt = useDesktopStore((s) => s.dismissUserPrompt);
  const monitors = useDesktopStore(useShallow((s) => s.monitors));
  const activeMonitorId = useDesktopStore((s) => s.activeMonitorId);
  const switchMonitor = useDesktopStore((s) => s.switchMonitor);
  const { sendUserPromptResponse } = useAgentConnection();

  /**
   * Take the box down only once the answer is on the wire, and follow the agent to its own
   * monitor. Dismissing unconditionally destroyed answers that a dead socket swallowed;
   * leaving the box up means the retry is one click away, and a reconnect re-shows it from
   * the server's snapshot regardless.
   */
  const settle = (
    prompt: UserPromptModel,
    answer: { selectedValues?: string[]; text?: string; dismissed?: boolean },
  ) => {
    if (!sendUserPromptResponse(prompt, answer)) return;
    dismissUserPrompt(prompt.id);
    if (!answer.dismissed && prompt.monitorId && prompt.monitorId !== activeMonitorId) {
      switchMonitor(prompt.monitorId);
    }
  };

  const handleSubmit = (prompt: UserPromptModel, selectedValues?: string[], text?: string) =>
    settle(prompt, { selectedValues, text });

  const handleDismiss = (prompt: UserPromptModel) => settle(prompt, { dismissed: true });

  if (prompts.length === 0) return null;

  const labelOf = (monitorId: string) =>
    monitors.find((m) => m.id === monitorId)?.label ?? monitorId;

  return (
    <div className={styles.overlay}>
      {prompts.map((prompt) => (
        <PromptBox
          key={prompt.id}
          prompt={prompt}
          askedBy={
            prompt.monitorId && prompt.monitorId !== activeMonitorId
              ? labelOf(prompt.monitorId)
              : null
          }
          onSubmit={handleSubmit}
          onDismiss={handleDismiss}
        />
      ))}
    </div>
  );
}
