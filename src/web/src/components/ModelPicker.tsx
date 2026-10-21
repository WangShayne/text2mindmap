import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { useI18n } from '../i18n'

/**
 * Model name input with a "Fetch models" button. The fetched list shows in a dropdown that filters as
 * you type; any name can still be typed by hand. The API key typed in the form (if any) is sent to the
 * server, which falls back to the stored key; the key is never returned.
 */
export function ModelPicker({ value, onChange, baseUrl, apiKey, placeholder, endpoint = '/api/settings/models', testId = 'model' }: {
  value: string
  onChange: (v: string) => void
  baseUrl: string
  apiKey: string
  placeholder?: string
  endpoint?: string
  testId?: string
}) {
  const { t } = useI18n()
  const [models, setModels] = useState<string[] | null>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [active, setActive] = useState(0)
  const wrap = useRef<HTMLDivElement>(null)

  // The list is tied to the endpoint it came from.
  useEffect(() => { setModels(null); setOpen(false); setStatus(null) }, [baseUrl])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const shown = useMemo(() => {
    if (!models) return []
    const q = query.trim().toLowerCase()
    return q ? models.filter((m) => m.toLowerCase().includes(q)) : models
  }, [models, query])
  useEffect(() => setActive(0), [query, models])

  const fetchModels = async () => {
    setLoading(true); setStatus(null)
    try {
      const r = await api<{ ok: true; models: string[] } | { ok: false; code: string; message: string }>('POST', endpoint, { baseUrl, apiKey })
      if (r.ok) {
        setModels(r.models)
        setQuery('')
        setOpen(r.models.length > 0)
        setStatus(r.models.length ? { ok: true, text: t('modelsFound', { n: r.models.length }) } : { ok: false, text: t('modelsEmpty') })
      } else {
        setStatus({ ok: false, text: t('modelsFailed', { msg: `[${r.code}] ${r.message}` }) })
      }
    } catch (e) {
      setStatus({ ok: false, text: t('modelsFailed', { msg: (e as Error).message }) })
    } finally { setLoading(false) }
  }

  const pick = (m: string) => { onChange(m); setOpen(false); setQuery('') }

  return (
    <div className="model-picker" ref={wrap}>
      <div className="row gap">
        <div className="combo grow">
          <input
            value={value}
            placeholder={placeholder}
            role="combobox"
            aria-expanded={open}
            aria-autocomplete="list"
            data-testid={`${testId}-input`}
            onChange={(e) => { onChange(e.target.value); setQuery(e.target.value); if (models?.length) setOpen(true) }}
            onFocus={() => { if (models?.length) { setQuery(''); setOpen(true) } }}
            onKeyDown={(e) => {
              if (!open || !shown.length) return
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, shown.length - 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
              else if (e.key === 'Enter') { e.preventDefault(); pick(shown[active]) }
              else if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) }
            }}
          />
          {!!models?.length && (
            <button type="button" className="combo-toggle" title={t('showModelList')} aria-label={t('showModelList')} onClick={() => { setQuery(''); setOpen((v) => !v) }}>▾</button>
          )}
          {open && !!models?.length && (
            <div className="combo-list" role="listbox" data-testid={`${testId}-list`}>
              {shown.length === 0 && <div className="combo-empty">{t('noMatch')}</div>}
              {shown.map((m, i) => (
                <button type="button" role="option" aria-selected={m === value} key={m}
                  className={`${i === active ? 'active' : ''} ${m === value ? 'selected' : ''}`}
                  onMouseEnter={() => setActive(i)} onClick={() => pick(m)}>
                  <span className="check">{m === value ? '✓' : ''}</span>{m}
                </button>
              ))}
            </div>
          )}
        </div>
        <button type="button" className="btn" data-testid={testId === 'model' ? 'fetch-models' : `${testId}-fetch-models`} onClick={fetchModels} disabled={loading}>
          {loading ? <><span className="spinner sm" /> {t('fetchingModels')}</> : <>⟳ {t('fetchModels')}</>}
        </button>
      </div>
      {status && <div className={`hint ${status.ok ? '' : 'error-text'}`} data-testid={`${testId}-models-status`}>{status.text}</div>}
    </div>
  )
}
