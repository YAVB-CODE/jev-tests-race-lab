/** Small form primitives for the control bar. */
import clsx from 'clsx'
import { useState } from 'react'
import type { ComponentProps, ReactNode } from 'react'

export const INPUT_CLASS =
  'h-8 rounded-md border border-line bg-panel-2 px-2.5 text-sm text-ink [color-scheme:dark] transition-colors hover:border-ink-faint focus-visible:outline focus-visible:outline-2 focus-visible:outline-info disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-line'

export function Field({
  label,
  hint,
  as: Tag = 'label',
  children,
  className,
}: {
  label: ReactNode
  hint?: string
  as?: 'label' | 'div'
  children: ReactNode
  className?: string
}) {
  return (
    <Tag className={clsx('flex min-w-0 flex-col gap-1', className)} title={hint} {...(Tag === 'div' ? { role: 'group' } : {})}>
      <span className="flex items-center gap-1.5 text-[11px] font-medium text-ink-dim">{label}</span>
      {children}
    </Tag>
  )
}

/**
 * Number input that keeps what the user is typing while the committed value is clamped by the store.
 * The draft is dropped on blur so the field shows the real (clamped) value again.
 */
export function NumberField({
  value,
  onCommit,
  min,
  max,
  step = 1,
  disabled,
  className,
  ariaLabel,
}: {
  value: number
  onCommit: (value: number) => void
  min: number
  max: number
  step?: number
  disabled?: boolean
  className?: string
  ariaLabel?: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      type="number"
      inputMode="decimal"
      aria-label={ariaLabel}
      className={clsx(INPUT_CLASS, 'tabular-nums', className)}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      value={draft ?? String(value)}
      onChange={(e) => {
        setDraft(e.target.value)
        const n = e.target.valueAsNumber
        if (Number.isFinite(n)) onCommit(n)
      }}
      onBlur={() => setDraft(null)}
    />
  )
}

export interface SegmentOption<T extends string> {
  value: T
  label: ReactNode
  /** Tooltip. */
  title?: string
  disabled?: boolean
}

/** Radio-style segmented control with per-option tooltip / disabled state. */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: T
  options: ReadonlyArray<SegmentOption<T>>
  onChange: (value: T) => void
  label: string
  disabled?: boolean
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex h-8 overflow-hidden rounded-md border border-line bg-panel-2">
      {options.map((o) => {
        const active = o.value === value
        const off = disabled || o.disabled
        return (
          // The tooltip lives on the wrapper: disabled buttons do not always show their own `title`.
          <span key={o.value} title={o.title} className="inline-flex">
            <button
              type="button"
              role="radio"
              aria-checked={active}
              disabled={off}
              onClick={() => onChange(o.value)}
              className={clsx(
                'px-3 text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info',
                active ? 'bg-line font-semibold text-ink' : 'text-ink-dim',
                off ? 'cursor-not-allowed' : 'hover:text-ink',
                off && !active && 'opacity-40',
                disabled && active && 'opacity-70',
              )}
            >
              {o.label}
            </button>
          </span>
        )
      })}
    </div>
  )
}

type ButtonVariant = 'primary' | 'default'

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: 'border-info bg-info font-semibold text-surface hover:brightness-110',
  default: 'border-line bg-panel-2 text-ink hover:border-ink-faint hover:bg-panel',
}

export function ActionButton({
  variant = 'default',
  className,
  ...props
}: { variant?: ButtonVariant } & ComponentProps<'button'>) {
  return (
    <button
      type="button"
      {...props}
      className={clsx(
        'inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-3.5 text-xs transition-[background-color,border-color,filter,opacity] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100',
        BUTTON_VARIANT[variant],
        className,
      )}
    />
  )
}

export function Chip({ tone, children, title, className }: { tone: string; children: ReactNode; title?: string; className?: string }) {
  return (
    <span
      title={title}
      className={clsx('inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] leading-none font-medium', tone, className)}
    >
      {children}
    </span>
  )
}
