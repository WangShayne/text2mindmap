import { useEffect, useRef, useState } from 'react'
import { useI18n, type TKey } from '../i18n'
import { MAP_LAYOUTS, MAP_THEMES, THEME_SWATCH, type MapLayout, type MapStyle } from '../../../shared/mapStyle'

const LAYOUT_ICON: Record<MapLayout, string> = { logicalStructure: '⊢', mindMap: '⟷', organizationStructure: '⊤' }

/** Compact palette button in the map header: map theme + structure. Saved per user, applies to all documents. */
export function MapStylePicker({ value, onChange }: { value: MapStyle; onChange: (s: MapStyle) => void }) {
  const { t } = useI18n()
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
      <button type="button" className={`icon-btn${open ? ' active' : ''}`} title={t('mapStyle')} aria-label={t('mapStyle')} aria-haspopup="dialog" aria-expanded={open} data-testid="map-style" onClick={() => setOpen((v) => !v)}>🎨</button>
      {open && (
        <div className="menu right style-pop" role="dialog" aria-label={t('mapStyle')}>
          <div className="menu-header">{t('mapTheme')}</div>
          <div className="theme-grid">
            {MAP_THEMES.map((id) => {
              const s = THEME_SWATCH[id]
              return (
                <button key={id} type="button" className={`theme-opt${value.theme === id ? ' on' : ''}`} data-testid={`theme-${id}`} aria-pressed={value.theme === id} onClick={() => onChange({ ...value, theme: id })}>
                  <span className="swatch" style={{ background: s.bg, borderColor: s.dark ? s.line : '#e5e7eb' }}>
                    <span className="sw-root" style={{ background: s.root }} />
                    <span className="sw-line" style={{ background: s.line }} />
                    <span className="sw-branch" style={{ background: s.branch, borderColor: s.line }} />
                  </span>
                  <span className="theme-name">{t(`theme_${id}` as TKey)}</span>
                </button>
              )
            })}
          </div>
          <div className="menu-divider" />
          <div className="menu-header">{t('mapLayout')}</div>
          {MAP_LAYOUTS.map((id) => (
            <button key={id} type="button" role="menuitemradio" aria-checked={value.layout === id} data-testid={`layout-${id}`} className={value.layout === id ? 'on' : ''} onClick={() => onChange({ ...value, layout: id })}>
              <span className="menu-ico">{LAYOUT_ICON[id]}</span><span className="grow">{t(`layout_${id}` as TKey)}</span><span className="check">{value.layout === id ? '✓' : ''}</span>
            </button>
          ))}
          <div className="menu-header small-note">{t('mapStyleNote')}</div>
        </div>
      )}
    </div>
  )
}
