/**
 * ComponentRenderer - Renders the component DSL as React components.
 * Button clicks emit COMPONENT_ACTION events back to the agent.
 */
import { memo, useCallback, useEffect, useState, createContext, useContext } from 'react'
import type {
  ComponentNode,
  Component,
  CardComponent,
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
  if (!node || !isComponent(node)) {
    return null
  }

  const component = node as Component

  switch (component.type) {
    case 'card':
      return <CardRenderer node={component} windowId={windowId} onAction={onAction} />
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

function CardRenderer({
  node,
  windowId,
  onAction,
}: {
  node: CardComponent
  windowId: string
  onAction?: (action: string, parallel?: boolean, formData?: Record<string, FormValue>, formId?: string, componentPath?: string[]) => void
}) {
  const parentPath = useComponentPath()
  const cardPath = [...parentPath, `Card${node.title ? `:${node.title}` : ''}`]

  const variantClass = node.variant === 'outlined'
    ? styles.cardOutlined
    : node.variant === 'elevated'
    ? styles.cardElevated
    : styles.cardDefault

  return (
    <ComponentPathContext.Provider value={cardPath}>
      <div className={`${styles.card} ${variantClass}`}>
        {(node.title || node.subtitle) && (
          <div className={styles.cardHeader}>
            {node.title && <div className={styles.cardTitle}>{node.title}</div>}
            {node.subtitle && <div className={styles.cardSubtitle}>{node.subtitle}</div>}
          </div>
        )}
        <div className={styles.cardContent}>
          <NodeRenderer node={node.content} windowId={windowId} onAction={onAction} />
        </div>
        {node.actions && (
          <div className={styles.cardActions}>
            <NodeRenderer node={node.actions} windowId={windowId} onAction={onAction} />
          </div>
        )}
      </div>
    </ComponentPathContext.Provider>
  )
}

function StackRenderer({
  node,
  windowId,
  onAction,
}: {
  node: StackComponent
  windowId: string
  onAction?: (action: string, parallel?: boolean, formData?: Record<string, FormValue>, formId?: string, componentPath?: string[]) => void
}) {
  const direction = node.direction || 'vertical'
  const gap = node.gap || 'md'
  const align = node.align || 'stretch'
  const justify = node.justify || 'start'

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
  const gap = node.gap || 'md'

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

  const variant = node.variant || 'secondary'
  const size = node.size || 'md'

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
  const variant = node.variant || 'body'
  const color = node.color || 'default'
  const align = node.align || 'left'

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
  const variant = node.variant || 'default'

  const className = [
    styles.badge,
    styles[`badge${variant.charAt(0).toUpperCase() + variant.slice(1)}`],
  ].filter(Boolean).join(' ')

  return <span className={className}>{node.label}</span>
}

function ProgressRenderer({ node }: { node: ProgressComponent }) {
  const variant = node.variant || 'default'
  const value = Math.max(0, Math.min(100, node.value))

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
  const variant = node.variant || 'info'

  const className = [
    styles.alert,
    styles[`alert${variant.charAt(0).toUpperCase() + variant.slice(1)}`],
  ].filter(Boolean).join(' ')

  return (
    <div className={className}>
      {node.title && <div className={styles.alertTitle}>{node.title}</div>}
      <div className={styles.alertMessage}>{node.message}</div>
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
  const variant = node.variant || 'solid'

  const className = [
    styles.divider,
    styles[`divider${variant.charAt(0).toUpperCase() + variant.slice(1)}`],
  ].filter(Boolean).join(' ')

  return <hr className={className} />
}

function SpacerRenderer({ node }: { node: SpacerComponent }) {
  const size = node.size || 'md'

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
  const layout = node.layout || 'vertical'
  const gap = node.gap || 'md'

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
