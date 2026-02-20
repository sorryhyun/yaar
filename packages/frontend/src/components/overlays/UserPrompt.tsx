/**
 * UserPrompt — renders ask/request prompts from the agent.
 *
 * - Options mode (ask): shows selectable options with optional freeform text.
 * - Input mode (request): shows a text input for the user to provide a response.
 * - Both can coexist in a single prompt.
 */
import { useState, useCallback } from 'react';
import { useDesktopStore, selectUserPrompts } from '@/store';
import { useShallow } from 'zustand/react/shallow';
import { useAgentConnection } from '@/hooks/useAgentConnection';
import type { UserPromptModel } from '@/types/state';
import styles from '@/styles/overlays/UserPrompt.module.css';

function PromptBox({
  prompt,
  onSubmit,
  onDismiss,
}: {
  prompt: UserPromptModel;
  onSubmit: (promptId: string, selectedValues?: string[], text?: string) => void;
  onDismiss: (promptId: string) => void;
}) {
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
    onSubmit(prompt.id, selectedValues, inputText);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && canSubmit) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className={styles.prompt}>
      <div className={styles.title}>{prompt.title}</div>
      <div className={styles.message}>{prompt.message}</div>

      {hasOptions && (
        <div className={styles.options}>
          {prompt.options!.map((opt) => (
            <div
              key={opt.value}
              className={styles.option}
              data-selected={selected.has(opt.value)}
              onClick={() => toggleOption(opt.value)}
            >
              <input
                type={prompt.multiSelect ? 'checkbox' : 'radio'}
                className={styles.optionRadio}
                checked={selected.has(opt.value)}
                onChange={() => toggleOption(opt.value)}
                name={`prompt-${prompt.id}`}
              />
              <div className={styles.optionContent}>
                <span className={styles.optionLabel}>{opt.label}</span>
                {opt.description && (
                  <span className={styles.optionDescription}>{opt.description}</span>
                )}
              </div>
            </div>
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
          <button className={styles.dismissButton} onClick={() => onDismiss(prompt.id)}>
            Skip
          </button>
        )}
        <button className={styles.submitButton} disabled={!canSubmit} onClick={handleSubmit}>
          Submit
        </button>
      </div>
    </div>
  );
}

export function UserPrompt() {
  const prompts = useDesktopStore(useShallow(selectUserPrompts)) as UserPromptModel[];
  const dismissUserPrompt = useDesktopStore((s) => s.dismissUserPrompt);
  const { sendUserPromptResponse } = useAgentConnection();

  const handleSubmit = (promptId: string, selectedValues?: string[], text?: string) => {
    sendUserPromptResponse(promptId, selectedValues, text);
    dismissUserPrompt(promptId);
  };

  const handleDismiss = (promptId: string) => {
    sendUserPromptResponse(promptId, undefined, undefined, true);
    dismissUserPrompt(promptId);
  };

  if (prompts.length === 0) return null;

  return (
    <div className={styles.overlay}>
      {prompts.map((prompt) => (
        <PromptBox
          key={prompt.id}
          prompt={prompt}
          onSubmit={handleSubmit}
          onDismiss={handleDismiss}
        />
      ))}
    </div>
  );
}
