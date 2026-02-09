/**
 * ComponentRenderer - Renders flat component arrays as CSS grid layouts.
 * Button clicks emit COMPONENT_ACTION events back to the agent.
 */
import { memo, useCallback, useState } from 'react'
import type {
  Component,
  ComponentLayout,
  ButtonComponent,
  TextComponent,
  BadgeComponent,
  ProgressComponent,
  ImageComponent,
  InputComponent,
  SelectComponent,
} from '@yaar/shared'
import { useFormContext, useFormField, type FormValue } from '@/contexts/FormContext'
import rendererStyles from '@/styles/windows/renderers.module.css'
import formStyles from '@/styles/base/forms.module.css'
import typographyStyles from '@/styles/base/typography.module.css'
import componentStyles from '@/styles/base/components.module.css'

// Normalize enum values - handles numbers, invalid strings, etc.
function normalizeEnum<T extends string>(value: unknown, validValues: readonly T[], defaultValue: T): T {
  if (typeof value === 'string' && validValues.includes(value as T)) {
    return value as T
  }
  return defaultValue
}

const GAP_VALUES = ['none', 'sm', 'md', 'lg'] as const
const BUTTON_VARIANT_VALUES = ['primary', 'secondary', 'ghost', 'danger'] as const
const BUTTON_SIZE_VALUES = ['sm', 'md', 'lg'] as const
const TEXT_VARIANT_VALUES = ['body', 'heading', 'subheading', 'caption', 'code'] as const
const TEXT_COLOR_VALUES = ['default', 'muted', 'accent', 'success', 'warning', 'error'] as const
const TEXT_ALIGN_VALUES = ['left', 'center', 'right'] as const
const BADGE_VARIANT_VALUES = ['default', 'success', 'warning', 'error', 'info'] as const
const PROGRESS_VARIANT_VALUES = ['default', 'success', 'warning', 'error'] as const

// ============ Layout Helpers ============

function colsToCss(cols?: number | number[]): string {
  if (!cols) return '1fr'
  if (typeof cols === 'number') return `repeat(${cols}, 1fr)`
  return cols.map(c => `${c}fr`).join(' ')
}

const GAP_CSS: Record<string, string> = {
  none: '0',
  sm: 'var(--space-1)',
  md: 'var(--space-2)',
  lg: 'var(--space-4)',
}

function gapToCss(gap: string): string {
  return GAP_CSS[gap] ?? GAP_CSS.md
}

// ============ Entry Point ============

interface ComponentRendererProps {
  data: unknown
  windowId?: string
  onAction?: (action: string, parallel?: boolean, formData?: Record<string, FormValue>, formId?: string, componentPath?: string[]) => void
}

import { FormProvider } from '@/contexts/FormContext'

export const ComponentRenderer = memo(function ComponentRenderer({
  data,
  onAction,
}: ComponentRendererProps) {
  const layout = data as ComponentLayout
  const components = layout?.components
  if (!Array.isArray(components)) return null

  const gap = normalizeEnum(layout.gap, GAP_VALUES, 'md')

  return (
    <FormProvider>
      <div
        className={rendererStyles.componentRoot}
        style={{
          display: 'grid',
          gridTemplateColumns: colsToCss(layout.cols),
          gap: gapToCss(gap),
        }}
      >
        {components.map((comp, i) => (
          <LeafRenderer key={i} node={comp as Component} onAction={onAction} />
        ))}
      </div>
    </FormProvider>
  )
})

// ============ Leaf Dispatcher ============

interface LeafRendererProps {
  node: Component
  onAction?: (action: string, parallel?: boolean, formData?: Record<string, FormValue>, formId?: string, componentPath?: string[]) => void
}

function LeafRenderer({ node, onAction }: LeafRendererProps) {
  if (!node || typeof node !== 'object' || !('type' in node)) return null

  switch (node.type) {
    case 'button':
      return <ButtonRenderer node={node} onAction={onAction} />
    case 'text':
      return <TextRenderer node={node} />
    case 'badge':
      return <BadgeRenderer node={node} />
    case 'progress':
      return <ProgressRenderer node={node} />
    case 'image':
      return <ImageRenderer node={node} />
    case 'input':
      return <InputRenderer node={node} />
    case 'select':
      return <SelectRenderer node={node} />
    default:
      return <span>[Unknown component type]</span>
  }
}

// ============ Component Renderers ============

const BUTTON_COOLDOWN_MS = 800

function ButtonRenderer({
  node,
  onAction,
}: {
  node: ButtonComponent
  onAction?: (action: string, parallel?: boolean, formData?: Record<string, FormValue>, formId?: string, componentPath?: string[]) => void
}) {
  const formContext = useFormContext()
  const [isProcessing, setIsProcessing] = useState(false)

  const handleClick = useCallback(() => {
    if (!node.disabled && !isProcessing && onAction) {
      setIsProcessing(true)
      setTimeout(() => setIsProcessing(false), BUTTON_COOLDOWN_MS)

      const isParallel = node.parallel !== false

      if (node.submitForm && formContext) {
        const formData = formContext.getFormData(node.submitForm)
        onAction(node.action, isParallel, formData, node.submitForm, [`Button:${node.label}`])
      } else {
        onAction(node.action, isParallel, undefined, undefined, [`Button:${node.label}`])
      }
    }
  }, [node.action, node.disabled, node.parallel, node.submitForm, node.label, onAction, formContext, isProcessing])

  const variant = normalizeEnum(node.variant, BUTTON_VARIANT_VALUES, 'secondary')
  const size = normalizeEnum(node.size, BUTTON_SIZE_VALUES, 'md')
  const disabled = node.disabled || isProcessing

  const className = [
    formStyles.button,
    formStyles[`button${variant.charAt(0).toUpperCase() + variant.slice(1)}`],
    formStyles[`buttonSize${size.charAt(0).toUpperCase() + size.slice(1)}`],
    disabled ? formStyles.buttonDisabled : '',
  ].filter(Boolean).join(' ')

  return (
    <button
      className={className}
      onClick={handleClick}
      disabled={disabled}
      type="button"
    >
      {node.icon && <span className={formStyles.buttonIcon}>{node.icon}</span>}
      {node.label}
    </button>
  )
}

function TextRenderer({ node }: { node: TextComponent }) {
  const variant = normalizeEnum(node.variant, TEXT_VARIANT_VALUES, 'body')
  const color = normalizeEnum(node.color, TEXT_COLOR_VALUES, 'default')
  const align = normalizeEnum(node.textAlign, TEXT_ALIGN_VALUES, 'left')

  const className = [
    typographyStyles.text,
    typographyStyles[`text${variant.charAt(0).toUpperCase() + variant.slice(1)}`],
    typographyStyles[`textColor${color.charAt(0).toUpperCase() + color.slice(1)}`],
    typographyStyles[`textAlign${align.charAt(0).toUpperCase() + align.slice(1)}`],
  ].filter(Boolean).join(' ')

  return <div className={className}>{node.content}</div>
}

function BadgeRenderer({ node }: { node: BadgeComponent }) {
  const variant = normalizeEnum(node.variant, BADGE_VARIANT_VALUES, 'default')

  const className = [
    componentStyles.badge,
    componentStyles[`badge${variant.charAt(0).toUpperCase() + variant.slice(1)}`],
  ].filter(Boolean).join(' ')

  return <span className={className}>{node.label}</span>
}

function ProgressRenderer({ node }: { node: ProgressComponent }) {
  const variant = normalizeEnum(node.variant, PROGRESS_VARIANT_VALUES, 'default')
  const value = Math.max(0, Math.min(100, typeof node.value === 'number' ? node.value : 0))

  const className = [
    componentStyles.progress,
    componentStyles[`progress${variant.charAt(0).toUpperCase() + variant.slice(1)}`],
  ].filter(Boolean).join(' ')

  return (
    <div className={className}>
      {node.label && <div className={componentStyles.progressLabel}>{node.label}</div>}
      <div className={componentStyles.progressTrack}>
        <div
          className={componentStyles.progressBar}
          style={{ width: `${value}%` }}
        />
      </div>
      {node.showValue && (
        <div className={componentStyles.progressValue}>{value}%</div>
      )}
    </div>
  )
}

function ImageRenderer({ node }: { node: ImageComponent }) {
  const fit = node.fit || 'contain'

  const style: React.CSSProperties = {
    objectFit: fit,
    width: node.width,
    height: node.height,
  }

  return (
    <img
      className={componentStyles.image}
      src={node.src}
      alt=""
      style={style}
    />
  )
}

// ============ Form Field Renderers ============

function InputRenderer({ node }: { node: InputComponent }) {
  const formId = node.formId
  const initialValue = node.defaultValue ?? ''
  const { setValue } = useFormField(formId, node.name, initialValue)
  const [localValue, setLocalValue] = useState(String(initialValue))
  const isMultiline = node.rows !== undefined

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = node.variant === 'number' ? e.target.valueAsNumber || e.target.value : e.target.value
    setLocalValue(e.target.value)
    setValue(newValue)
  }, [node.variant, setValue])

  const handleTextareaChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setLocalValue(e.target.value)
    setValue(e.target.value)
  }, [setValue])

  const inputType = node.variant || 'text'

  return (
    <div className={formStyles.formField}>
      {node.label && <label className={formStyles.formLabel}>{node.label}</label>}
      {isMultiline ? (
        <textarea
          className={formStyles.formTextarea}
          placeholder={node.placeholder}
          rows={node.rows}
          value={localValue}
          onChange={handleTextareaChange}
          disabled={node.disabled}
        />
      ) : (
        <input
          type={inputType}
          className={formStyles.formInput}
          placeholder={node.placeholder}
          value={localValue}
          onChange={handleInputChange}
          disabled={node.disabled}
        />
      )}
    </div>
  )
}

function SelectRenderer({ node }: { node: SelectComponent }) {
  const formId = node.formId
  const initialValue = node.defaultValue ?? ''
  const { setValue } = useFormField(formId, node.name, initialValue)
  const [localValue, setLocalValue] = useState(String(initialValue))

  const handleChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setLocalValue(e.target.value)
    setValue(e.target.value)
  }, [setValue])

  return (
    <div className={formStyles.formField}>
      {node.label && <label className={formStyles.formLabel}>{node.label}</label>}
      <select
        className={formStyles.formSelect}
        value={localValue}
        onChange={handleChange}
        disabled={node.disabled}
      >
        {node.placeholder && (
          <option value="" disabled>
            {node.placeholder}
          </option>
        )}
        {node.options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  )
}
