import { useEffect, useRef, useState, type ReactNode } from 'react'

export interface MenuItem { key: string; label: ReactNode; icon?: ReactNode; onSelect: () => void; disabled?: boolean; danger?: boolean; divider?: boolean }

/** Button with a popover menu. Closes on outside click, Escape, or after a choice. */
export function Menu({ trigger, items, title, className = 'btn', align = 'right', up = false, testId, header }: {
  trigger: ReactNode
  items: MenuItem[]
  title?: string
  className?: string
  align?: 'left' | 'right'
  up?: boolean
  testId?: string
  header?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  return (
    <div className="menu-wrap" ref={wrap}>
      <button type="button" className={`${className}${open ? ' active' : ''}`} title={title} aria-label={title} aria-haspopup="menu" aria-expanded={open} data-testid={testId} onClick={() => setOpen((v) => !v)}>{trigger}</button>
      {open && (
        <div className={`menu ${align} ${up ? 'up' : ''}`} role="menu">
          {header && <div className="menu-header">{header}</div>}
          {items.map((it) => (
            <div key={it.key} className="menu-row">
              {it.divider && <div className="menu-divider" />}
              <button type="button" role="menuitem" disabled={it.disabled} className={it.danger ? 'danger' : ''} onClick={() => { setOpen(false); it.onSelect() }}>
                <span className="menu-ico">{it.icon}</span><span>{it.label}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
