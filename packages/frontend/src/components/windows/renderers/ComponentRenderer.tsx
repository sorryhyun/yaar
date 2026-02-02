/**
 * ComponentRenderer - Renders the component DSL as React components.
 * Button clicks emit COMPONENT_ACTION events back to the agent.
 */
import { memo, useCallback, useEffect, useState, createContext, useContext } from 'react'
import type {
  ComponentNode,
  Component,
  StackComponent,
  GridComponent,
  ButtonComponent,
  TextComponent,
  ListComponent,
  BadgeComponent,
  ProgressComponent,
  AlertComponent,
  ImageComponent,
  MarkdownComponent,
  DividerComponent,
  SpacerComponent,
  FormComponent,
  InputComponent,
  TextareaComponent,
  SelectComponent,
} from '@claudeos/shared'
import { isComponent } from '@claudeos/shared'
import { MarkdownRenderer } from './MarkdownRenderer'
import { useFormContext, useFormField, type FormValue } from '@/contexts/FormContext'
import styles from '@/styles/renderers.module.css'

// Normalize enum values - handles numbers, invalid strings, etc.
function normalizeEnum<T extends string>(value: unknown, validValues: readonly T[], defaultValue: T): T {
  if (typeof value === 'string' && validValues.includes(value as T)) {
    return value as T
  }
  return defaultValue
}

const GAP_VALUES = ['none', 'sm', 'md', 'lg'] as const
const DIRECTION_VALUES = ['horizontal', 'vertical'] as const
const ALIGN_VALUES = ['start', 'center', 'end', 'stretch'] as const
const JUSTIFY_VALUES = ['start', 'center', 'end', 'between', 'around'] as const
const BUTTON_VARIANT_VALUES = ['primary', 'secondary', 'ghost', 'danger'] as const
const BUTTON_SIZE_VALUES = ['sm', 'md', 'lg'] as const
const TEXT_VARIANT_VALUES = ['body', 'heading', 'subheading', 'caption', 'code'] as const
const TEXT_COLOR_VALUES = ['default', 'muted', 'accent', 'success', 'warning', 'error'] as const
const TEXT_ALIGN_VALUES = ['left', 'center', 'right'] as const
const BADGE_VARIANT_VALUES = ['default', 'success', 'warning', 'error', 'info'] as const
const PROGRESS_VARIANT_VALUES = ['default', 'success', 'warning', 'error'] as const
const ALERT_VARIANT_VALUES = ['info', 'success', 'warning', 'error'] as const
const DIVIDER_VARIANT_VALUES = ['solid', 'dashed'] as const
const SIZE_VALUES = ['sm', 'md', 'lg'] as const
const LAYOUT_VALUES = ['vertical', 'horizontal'] as const

// Context to pass current form ID to nested components
const FormIdContext = createContext<string | undefined>(undefined)

function useCurrentFormId(): string | undefined {
  return useContext(FormIdContext)
}

// Context to track component path through the tree
const ComponentPathContext = createContext<string[]>([])

function useComponentPath(): string[] {
  return useContext(ComponentPathContext)
}

interface ComponentRendererProps {
  data: ComponentNode
  windowId: string
  onAction?: (action: string, parallel?: boolean, formData?: Record<string, FormValue>, formId?: string, componentPath?: string[]) => void
}

import { FormProvider } from '@/contexts/FormContext'

export const ComponentRenderer = memo(function ComponentRenderer({
  data,
  windowId,
  onAction,
}: ComponentRendererProps) {
  return (
    <FormProvider>
      <div className={styles.componentRoot}>
        <NodeRenderer node={data} windowId={windowId} onAction={onAction} />
      </div>
    </FormProvider>
  )
})

interface NodeRendererProps {
  node: ComponentNode
  windowId: string
  onAction?: (action: string, parallel?: boolean, formData?: Record<string, FormValue>, formId?: string, componentPath?: string[]) => void
}

function NodeRenderer({ node, windowId, onAction }: NodeRendererProps) {
  // Handle string shorthand
  if (typeof node === 'string') {
    return <span>{node}</span>
  }

  // Handle null/undefined
  if (!node) {
    return null
  }

  // Handle arrays - render as horizontal stack (common for action buttons)
  if (Array.isArray(node)) {
    return (
      <div className={`${styles.stack} ${styles.stackDirHorizontal} ${styles.stackGapSm}`}>
        {node.map((child, i) => (
          <NodeRenderer key={i} node={child} windowId={windowId} onAction={onAction} />
        ))}
      </div>
    )
  }

  // Handle non-component objects
  if (!isComponent(node)) {
    return null
  }

  const component = node as Component

  switch (component.type) {
    case 'stack':
      return <StackRenderer node={component} windowId={windowId} onAction={onAction} />
    case 'grid':
      return <GridRenderer node={component} windowId={windowId} onAction={onAction} />
    case 'button':
      return <ButtonRenderer node={component} onAction={onAction} />
    case 'text':
      return <TextRenderer node={component} />
    case 'list':
      return <ListRenderer node={component} windowId={windowId} onAction={onAction} />
    case 'badge':
      return <BadgeRenderer node={component} />
    case 'progress':
      return <ProgressRenderer node={component} />
    case 'alert':
      return <AlertRenderer node={component} />
    case 'image':
      return <ImageRenderer node={component} />
    case 'markdown':
      return <MarkdownNodeRenderer node={component} />
    case 'divider':
      return <DividerRenderer node={component} />
    case 'spacer':
      return <SpacerRenderer node={component} />
    case 'form':
      return <FormRenderer node={component} windowId={windowId} onAction={onAction} />
    case 'input':
      return <InputRenderer node={component} />
    case 'textarea':
      return <TextareaRenderer node={component} />
    case 'select':
      return <SelectRenderer node={component} />
    default:
      return <span>[Unknown component type]</span>
  }
}

// ============ Component Renderers ============

function StackRenderer({
  node,
  windowId,
  onAction,
}: {
  node: StackComponent
  windowId: string
  onAction?: (action: string, parallel?: boolean, formData?: Record<string, FormValue>, formId?: string, componentPath?: string[]) => void
}) {
  const direction = normalizeEnum(node.direction, DIRECTION_VALUES, 'vertical')
  const gap = normalizeEnum(node.gap, GAP_VALUES, 'md')
  const align = normalizeEnum(node.align, ALIGN_VALUES, 'stretch')
  const justify = normalizeEnum(node.justify, JUSTIFY_VALUES, 'start')

  const className = [
    styles.stack,
    styles[`stackDir${direction.charAt(0).toUpperCase() + direction.slice(1)}`],
    styles[`stackGap${gap.charAt(0).toUpperCase() + gap.slice(1)}`],
    styles[`stackAlign${align.charAt(0).toUpperCase() + align.slice(1)}`],
    styles[`stackJustify${justify.charAt(0).toUpperCase() + justify.slice(1)}`],
    node.wrap ? styles.stackWrap : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={className}>
      {node.children.map((child, i) => (
        <NodeRenderer key={i} node={child} windowId={windowId} onAction={onAction} />
      ))}
    </div>
  )
}

function GridRenderer({
  node,
  windowId,
  onAction,
}: {
  node: GridComponent
  windowId: string
  onAction?: (action: string, parallel?: boolean, formData?: Record<string, FormValue>, formId?: string, componentPath?: string[]) => void
}) {
  const columns = node.columns || 'auto'
  const gap = normalizeEnum(node.gap, GAP_VALUES, 'md')

  const style = columns !== 'auto'
    ? { gridTemplateColumns: `repeat(${columns}, 1fr)` }
    : undefined

  const className = [
    styles.grid,
    styles[`gridGap${gap.charAt(0).toUpperCase() + gap.slice(1)}`],
    columns === 'auto' ? styles.gridAuto : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={className} style={style}>
      {node.children.map((child, i) => (
        <NodeRenderer key={i} node={child} windowId={windowId} onAction={onAction} />
      ))}
    </div>
  )
}

function ButtonRenderer({
  node,
  onAction,
}: {
  node: ButtonComponent
  onAction?: (action: string, parallel?: boolean, formData?: Record<string, FormValue>, formId?: string, componentPath?: string[]) => void
}) {
  const formContext = useFormContext()
  const currentFormId = useCurrentFormId()
  const parentPath = useComponentPath()

  // Build full component path including this button
  const fullPath = [...parentPath, `Button:${node.label}`]

  const handleClick = useCallback(() => {
    if (!node.disabled && onAction) {
      // Default to parallel execution (parallel: true unless explicitly set to false)
      const isParallel = node.parallel !== false

      // If submitForm is specified, collect form data
      if (node.submitForm && formContext) {
        const formData = formContext.getFormData(node.submitForm)
        onAction(node.action, isParallel, formData, node.submitForm, fullPath)
      } else if (currentFormId && formContext) {
        // If inside a form, submit that form's data
        const formData = formContext.getFormData(currentFormId)
        onAction(node.action, isParallel, formData, currentFormId, fullPath)
      } else {
        onAction(node.action, isParallel, undefined, undefined, fullPath)
      }
    }
  }, [node.action, node.disabled, node.parallel, node.submitForm, onAction, formContext, currentFormId, fullPath])

  const variant = normalizeEnum(node.variant, BUTTON_VARIANT_VALUES, 'secondary')
  const size = normalizeEnum(node.size, BUTTON_SIZE_VALUES, 'md')

  const className = [
    styles.button,
    styles[`button${variant.charAt(0).toUpperCase() + variant.slice(1)}`],
    styles[`buttonSize${size.charAt(0).toUpperCase() + size.slice(1)}`],
    node.disabled ? styles.buttonDisabled : '',
  ].filter(Boolean).join(' ')

  return (
    <button
      className={className}
      onClick={handleClick}
      disabled={node.disabled}
      type="button"
    >
      {node.icon && <span className={styles.buttonIcon}>{node.icon}</span>}
      {node.label}
    </button>
  )
}

function TextRenderer({ node }: { node: TextComponent }) {
  const variant = normalizeEnum(node.variant, TEXT_VARIANT_VALUES, 'body')
  const color = normalizeEnum(node.color, TEXT_COLOR_VALUES, 'default')
  const align = normalizeEnum(node.align, TEXT_ALIGN_VALUES, 'left')

  const className = [
    styles.text,
    styles[`text${variant.charAt(0).toUpperCase() + variant.slice(1)}`],
    styles[`textColor${color.charAt(0).toUpperCase() + color.slice(1)}`],
    styles[`textAlign${align.charAt(0).toUpperCase() + align.slice(1)}`],
  ].filter(Boolean).join(' ')

  return <div className={className}>{node.content}</div>
}

function ListRenderer({
  node,
  windowId,
  onAction,
}: {
  node: ListComponent
  windowId: string
  onAction?: (action: string, parallel?: boolean, formData?: Record<string, FormValue>, formId?: string, componentPath?: string[]) => void
}) {
  const Tag = node.variant === 'ordered' ? 'ol' : 'ul'

  return (
    <Tag className={styles.list}>
      {node.items.map((item, i) => (
        <li key={i} className={styles.listItem}>
          <NodeRenderer node={item} windowId={windowId} onAction={onAction} />
        </li>
      ))}
    </Tag>
  )
}

function BadgeRenderer({ node }: { node: BadgeComponent }) {
  const variant = normalizeEnum(node.variant, BADGE_VARIANT_VALUES, 'default')

  const className = [
    styles.badge,
    styles[`badge${variant.charAt(0).toUpperCase() + variant.slice(1)}`],
  ].filter(Boolean).join(' ')

  return <span className={className}>{node.label}</span>
}

function ProgressRenderer({ node }: { node: ProgressComponent }) {
  const variant = normalizeEnum(node.variant, PROGRESS_VARIANT_VALUES, 'default')
  const value = Math.max(0, Math.min(100, typeof node.value === 'number' ? node.value : 0))

  const className = [
    styles.progress,
    styles[`progress${variant.charAt(0).toUpperCase() + variant.slice(1)}`],
  ].filter(Boolean).join(' ')

  return (
    <div className={className}>
      {node.label && <div className={styles.progressLabel}>{node.label}</div>}
      <div className={styles.progressTrack}>
        <div
          className={styles.progressBar}
          style={{ width: `${value}%` }}
        />
      </div>
      {node.showValue && (
        <div className={styles.progressValue}>{value}%</div>
      )}
    </div>
  )
}

function AlertRenderer({ node }: { node: AlertComponent }) {
  const variant = normalizeEnum(node.variant, ALERT_VARIANT_VALUES, 'info')
  const message = node.message ?? node.content ?? ''

  const className = [
    styles.alert,
    styles[`alert${variant.charAt(0).toUpperCase() + variant.slice(1)}`],
  ].filter(Boolean).join(' ')

  return (
    <div className={className}>
      {node.title && <div className={styles.alertTitle}>{node.title}</div>}
      <div className={styles.alertMessage}>{message}</div>
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
      className={styles.image}
      src={node.src}
      alt={node.alt || ''}
      style={style}
    />
  )
}

function MarkdownNodeRenderer({ node }: { node: MarkdownComponent }) {
  return <MarkdownRenderer data={node.content} />
}

function DividerRenderer({ node }: { node: DividerComponent }) {
  const variant = normalizeEnum(node.variant, DIVIDER_VARIANT_VALUES, 'solid')

  const className = [
    styles.divider,
    styles[`divider${variant.charAt(0).toUpperCase() + variant.slice(1)}`],
  ].filter(Boolean).join(' ')

  return <hr className={className} />
}

function SpacerRenderer({ node }: { node: SpacerComponent }) {
  const size = normalizeEnum(node.size, SIZE_VALUES, 'md')

  const className = [
    styles.spacer,
    styles[`spacer${size.charAt(0).toUpperCase() + size.slice(1)}`],
  ].filter(Boolean).join(' ')

  return <div className={className} />
}

// ============ Form Component Renderers ============

function FormRenderer({
  node,
  windowId,
  onAction,
}: {
  node: FormComponent
  windowId: string
  onAction?: (action: string, parallel?: boolean, formData?: Record<string, FormValue>, formId?: string, componentPath?: string[]) => void
}) {
  const formContext = useFormContext()
  const parentPath = useComponentPath()
  const formPath = [...parentPath, `Form:${node.id}`]
  const layout = normalizeEnum(node.layout, LAYOUT_VALUES, 'vertical')
  const gap = normalizeEnum(node.gap, GAP_VALUES, 'md')

  // Register form on mount
  useEffect(() => {
    if (formContext) {
      formContext.registerForm(node.id)
      return () => formContext.unregisterForm(node.id)
    }
  }, [node.id, formContext])

  const className = [
    styles.form,
    styles[`formLayout${layout.charAt(0).toUpperCase() + layout.slice(1)}`],
    styles[`formGap${gap.charAt(0).toUpperCase() + gap.slice(1)}`],
  ].filter(Boolean).join(' ')

  return (
    <FormIdContext.Provider value={node.id}>
      <ComponentPathContext.Provider value={formPath}>
        <div className={className}>
          {node.children.map((child, i) => (
            <NodeRenderer key={i} node={child} windowId={windowId} onAction={onAction} />
          ))}
        </div>
      </ComponentPathContext.Provider>
    </FormIdContext.Provider>
  )
}

function InputRenderer({ node }: { node: InputComponent }) {
  const formId = useCurrentFormId()
  const initialValue = node.defaultValue ?? ''
  const { setValue } = useFormField(formId, node.name, initialValue)
  const [localValue, setLocalValue] = useState(String(initialValue))

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = node.variant === 'number' ? e.target.valueAsNumber || e.target.value : e.target.value
    setLocalValue(e.target.value)
    setValue(newValue)
  }, [node.variant, setValue])

  const inputType = node.variant || 'text'

  return (
    <div className={styles.formField}>
      {node.label && <label className={styles.formLabel}>{node.label}</label>}
      <input
        type={inputType}
        className={styles.formInput}
        placeholder={node.placeholder}
        defaultValue={node.defaultValue}
        value={localValue}
        onChange={handleChange}
        disabled={node.disabled}
      />
    </div>
  )
}

function TextareaRenderer({ node }: { node: TextareaComponent }) {
  const formId = useCurrentFormId()
  const initialValue = node.defaultValue ?? ''
  const { setValue } = useFormField(formId, node.name, initialValue)
  const [localValue, setLocalValue] = useState(String(initialValue))

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setLocalValue(e.target.value)
    setValue(e.target.value)
  }, [setValue])

  return (
    <div className={styles.formField}>
      {node.label && <label className={styles.formLabel}>{node.label}</label>}
      <textarea
        className={styles.formTextarea}
        placeholder={node.placeholder}
        rows={node.rows || 3}
        value={localValue}
        onChange={handleChange}
        disabled={node.disabled}
      />
    </div>
  )
}

function SelectRenderer({ node }: { node: SelectComponent }) {
  const formId = useCurrentFormId()
  const initialValue = node.defaultValue ?? ''
  const { setValue } = useFormField(formId, node.name, initialValue)
  const [localValue, setLocalValue] = useState(String(initialValue))

  const handleChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setLocalValue(e.target.value)
    setValue(e.target.value)
  }, [setValue])

  return (
    <div className={styles.formField}>
      {node.label && <label className={styles.formLabel}>{node.label}</label>}
      <select
        className={styles.formSelect}
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
