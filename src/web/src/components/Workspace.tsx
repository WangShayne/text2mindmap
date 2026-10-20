import { useCallback, useEffect, useRef, useState } from 'react'
import { api, streamGenerate, type Doc, type GenEvent } from '../api'
import { useI18n } from '../i18n'
import { MarkdownEditor, type EditorHandle } from './MarkdownEditor'
import { GenerateDialog, type GenRequest } from './GenerateDialog'
import { Menu } from './Menu'
import { createSimpleMindMap } from '../mindmap/simpleMindMapAdapter'
import type { ExportFormat, MapCommand, MindMapAdapter, Selection } from '../mindmap/adapter'
import { parseMarkdown, serializeOutline, type OutlineNode } from '../../../shared/outline'

type SaveState = 'saved' | 'saving' | 'dirty' | 'error'

function download(name: string, content: string, type: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([content], { type }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

export async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return } catch { /* fall back for http:// */ }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'; ta.style.opacity = '0'
  document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove()
}

const isDefaultTitle = (s: string) => !s || s === 'Untitled' || s === '未命名'

export function Workspace({ doc, onMetaChange, settings, onImport, onAbout, onToggleNav }: {
  doc: Doc
  onMetaChange: (d: Partial<Doc> & { id: string }) => void
  settings: { chunkChars: number; maxInputChars: number; configured: boolean }
  onImport: () => void
  onAbout: () => void
  onToggleNav: () => void
}) {
  const { t } = useI18n()
  const editor = useRef<EditorHandle>(null)
  const mapEl = useRef<HTMLDivElement>(null)
  const map = useRef<MindMapAdapter | null>(null)
  const shown = useRef('') // canonical Markdown of what the map currently shows
  const title = useRef(doc.title)
  title.current = doc.title
  const [selection, setSelection] = useState<Selection | null>(null)
  const [save, setSave] = useState<SaveState>('saved')
  const [genOpen, setGenOpen] = useState<null | 'full' | 'expand'>(null)
  const [gen, setGen] = useState<{ status: string; running: boolean; error?: boolean } | null>(null)
  const [toast, setToast] = useState('')
  const abort = useRef<AbortController | null>(null)
  const saveTimer = useRef<number | undefined>(undefined)
  const syncTimer = useRef<number | undefined>(undefined)
  const pending = useRef<string | null>(null)

  // ---------- persistence ----------
  const flush = useCallback(async () => {
    window.clearTimeout(saveTimer.current)
    const md = pending.current
    if (md === null) return
    pending.current = null
    setSave('saving')
    try {
      const r = await api<{ doc: Doc }>('PUT', `/api/docs/${doc.id}`, { markdown: md })
      onMetaChange({ id: doc.id, updated_at: r.doc.updated_at })
      setSave(pending.current === null ? 'saved' : 'dirty')
    } catch { setSave('error'); pending.current = pending.current ?? md }
  }, [doc.id, onMetaChange])

  const scheduleSave = (md: string) => {
    pending.current = md
    setSave('dirty')
    window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(flush, 800)
  }

  useEffect(() => {
    const before = () => {
      if (pending.current !== null) fetch(`/api/docs/${doc.id}`, { method: 'PUT', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ markdown: pending.current }) })
    }
    window.addEventListener('beforeunload', before)
    return () => { window.removeEventListener('beforeunload', before); void flush() }
  }, [doc.id, flush])

  // ---------- map <-> markdown sync ----------
  const renderFromMarkdown = (md: string, reset = false) => {
    const tree = parseMarkdown(md, title.current)
    const canonical = serializeOutline(tree)
    if (!reset && canonical === shown.current) return
    shown.current = canonical
    map.current?.setOutline(tree, { reset })
  }

  useEffect(() => {
    const m = createSimpleMindMap(mapEl.current!)
    map.current = m
    renderFromMarkdown(doc.markdown, true)
    const offChange = m.onChange((tree: OutlineNode) => {
      const canonical = serializeOutline(tree)
      if (canonical === shown.current) return // echo of an editor-driven render
      shown.current = canonical
      const current = editor.current?.getText() ?? ''
      // Only rewrite the editor when the structure really differs, so the author's formatting survives.
      if (serializeOutline(parseMarkdown(current, title.current)) !== canonical) editor.current?.setText(canonical, 'map')
    })
    const offSel = m.onSelect(setSelection)
    return () => { offChange(); offSel(); m.destroy(); map.current = null }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id])

  const onEditorChange = (text: string, origin: string | null) => {
    scheduleSave(text)
    if (origin === 'map') return
    window.clearTimeout(syncTimer.current)
    syncTimer.current = window.setTimeout(() => renderFromMarkdown(text), origin === 'gen' ? 120 : 250)
  }

  // ---------- generation ----------
  const runGeneration = async (req: GenRequest) => {
    setGenOpen(null)
    const ac = new AbortController()
    abort.current = ac
    const before = editor.current!.getText()
    let acc = ''
    let finalMd: string | null = null
    setGen({ status: t('generating'), running: true })
    const onEvent = (e: GenEvent) => {
      if (e.type === 'progress') setGen({ running: true, status: e.stage === 'merge' ? t('merging') : t('chunkProgress', { i: e.index!, n: e.total! }) })
      else if (e.type === 'retry') { acc = ''; setGen({ running: true, status: t('retrying', { reason: e.reason }) }); if (req.mode === 'full') editor.current!.setText(before, 'gen') }
      else if (e.type === 'delta') {
        acc += e.text
        if (req.mode === 'full') editor.current!.setText(acc, 'gen')
        else setGen({ running: true, status: `${t('generating')} ${acc.split('\n').filter(Boolean).length}` })
      } else if (e.type === 'done') finalMd = e.markdown
      else if (e.type === 'error') throw Object.assign(new Error(e.message), { code: e.code })
    }
    try {
      if (req.mode === 'full') {
        await streamGenerate({ mode: 'full', text: req.text, title: title.current }, onEvent, ac.signal)
      } else {
        const tree = parseMarkdown(before, title.current)
        let node = tree
        for (const i of req.selection.indices) node = node.children[i] ?? node
        await streamGenerate({ mode: 'expand', markdown: serializeOutline(tree), path: req.selection.texts, existing: node.children.map((c) => c.text), instructions: req.instructions }, onEvent, ac.signal)
      }
      if (finalMd === null) throw new Error('The server closed the stream before finishing.')
      if (req.mode === 'full') {
        editor.current!.setText(finalMd, 'gen')
        const root = parseMarkdown(finalMd).text
        if (isDefaultTitle(title.current) && root) {
          onMetaChange({ id: doc.id, title: root })
          api('PUT', `/api/docs/${doc.id}`, { title: root }).catch(() => {})
        }
      } else {
        // Re-read the document in case it changed while generating, then append under the same node.
        const tree = parseMarkdown(editor.current!.getText(), title.current)
        let node = tree
        for (const i of req.selection.indices) node = node.children[i] ?? node
        node.children.push(...parseMarkdown(`# x\n${finalMd}`).children.map((c) => ({ ...c, kind: 'list' as const })))
        editor.current!.setText(serializeOutline(tree), 'gen')
      }
      setTimeout(() => map.current?.command('fit'), 400)
      setGen({ running: false, status: t('generated') })
      setTimeout(() => setGen((g) => (g && !g.running && !g.error ? null : g)), 2500)
    } catch (e) {
      if (ac.signal.aborted) {
        if (req.mode === 'full' && acc) editor.current!.setText(serializeOutline(parseMarkdown(acc, title.current)), 'gen')
        setGen({ running: false, status: t('stopped') })
      } else {
        if (req.mode === 'full') editor.current!.setText(before, 'gen')
        setGen({ running: false, error: true, status: (e as Error).message })
      }
    } finally {
      abort.current = null
    }
  }

  const startFromDialog = (req: GenRequest) => {
    if (req.mode === 'full') {
      const cur = editor.current!.getText().trim()
      const trivial = !cur || /^#\s[^\n]*$/.test(cur)
      if (!trivial && !window.confirm(t('confirmReplace'))) return
    }
    void runGeneration(req)
  }

  // ---------- export ----------
  const fileBase = (doc.title || 'mindmap').replace(/[\\/:*?"<>|]/g, '_')
  const doExport = async (f: ExportFormat | 'md' | 'opml') => {
    await flush()
    try {
      if (f === 'md') download(`${fileBase}.md`, editor.current!.getText(), 'text/markdown;charset=utf-8')
      else if (f === 'opml') window.location.href = `/api/docs/${doc.id}/export?format=opml`
      else await map.current!.exportAs(f, fileBase)
    } catch (e) { setToast(t('exportFailed', { msg: (e as Error).message })) }
  }
  const cmd = (c: MapCommand) => map.current?.command(c)

  useEffect(() => { if (toast) { const id = setTimeout(() => setToast(''), 2500); return () => clearTimeout(id) } }, [toast])

  return (
    <div className="workspace">
      <div className="toolbar">
        <button className="icon-btn nav-toggle" title={t('menu')} aria-label={t('menu')} onClick={onToggleNav}>☰</button>
        <input className="title-input" value={doc.title} title={doc.title} onChange={(e) => onMetaChange({ id: doc.id, title: e.target.value })}
          onBlur={(e) => api('PUT', `/api/docs/${doc.id}`, { title: e.target.value }).then((r: any) => onMetaChange({ id: doc.id, title: r.doc.title })).catch(() => {})} />
        <span className={`save-state ${save}`}>{save === 'saving' ? t('saving') : save === 'error' ? t('saveFailed') : save === 'dirty' ? '•' : t('saved')}</span>
        <div className="toolbar-actions">
          {gen?.running
            ? <button className="btn danger" data-testid="stop" onClick={() => abort.current?.abort()}><span className="ico">■</span><span className="lbl">{t('stop')}</span></button>
            : <button className="btn primary" data-testid="generate" onClick={() => setGenOpen('full')}><span className="ico">✨</span><span className="lbl">{t('generate')}</span></button>}
          <button className="btn collapsible" disabled={!!gen?.running || !selection} title={t('modeExpand')} aria-label={t('modeExpand')} onClick={() => setGenOpen('expand')}><span className="ico">＋</span><span className="lbl">{t('expandShort')}</span></button>
          <Menu title={t('export')} testId="export-menu" trigger={<><span className="ico">⇩</span><span className="lbl">{t('export')}</span><span className="caret">▾</span></>} items={[
            { key: 'md', label: 'Markdown (.md)', onSelect: () => doExport('md') },
            ...(map.current?.exportFormats ?? []).map((f) => ({ key: f, label: `${f.toUpperCase()} (.${f})`, onSelect: () => doExport(f) })),
            { key: 'opml', label: 'OPML (.opml)', onSelect: () => doExport('opml') },
          ]} />
          <Menu className="btn icon-only" title={t('more')} testId="more-menu" trigger="⋯" items={[
            { key: 'import', icon: '⇪', label: t('importMd'), onSelect: onImport },
            { key: 'copy', icon: '📋', label: t('copyMd'), onSelect: async () => { await copyText(editor.current!.getText()); setToast(t('copied')) } },
            { key: 'about', icon: 'ⓘ', label: t('about'), onSelect: onAbout, divider: true },
          ]} />
        </div>
      </div>
      {!settings.configured && <div className="banner warn">{t('notConfigured')}</div>}
      {gen && (
        <div className={`banner ${gen.error ? 'err' : gen.running ? 'info' : 'ok'}`}>
          {gen.running && <span className="spinner" />}
          <span className="grow">{gen.status}</span>
          {!gen.running && <button className="icon-btn" title={t('close')} aria-label={t('close')} onClick={() => setGen(null)}>✕</button>}
        </div>
      )}
      <div className="panes">
        <section className="pane editor-pane">
          <div className="pane-head">{t('editor')}</div>
          <MarkdownEditor key={doc.id} ref={editor} initial={doc.markdown} placeholder={t('emptyDoc')} onChange={onEditorChange} />
        </section>
        <section className="pane map-pane">
          <div className="pane-head row">
            <span>{t('map')}</span>
            <div className="spacer" />
            <button className="icon-btn" title={t('undo')} onClick={() => cmd('undo')}>↶</button>
            <button className="icon-btn" title={t('redo')} onClick={() => cmd('redo')}>↷</button>
            <button className="icon-btn" title={t('addChild')} disabled={!selection} onClick={() => cmd('addChild')}>⤷</button>
            <button className="icon-btn" title={t('addSibling')} disabled={!selection || selection.indices.length === 0} onClick={() => cmd('addSibling')}>↧</button>
            <button className="icon-btn" title={t('removeNode')} disabled={!selection || selection.indices.length === 0} onClick={() => cmd('remove')}>⌫</button>
            <button className="icon-btn" title={t('expandAll')} onClick={() => cmd('expandAll')}>⊞</button>
            <button className="icon-btn" title={t('collapseAll')} onClick={() => cmd('collapseAll')}>⊟</button>
            <button className="icon-btn" title={t('fit')} onClick={() => cmd('fit')}>⤢</button>
          </div>
          <div className="map-host" ref={mapEl} />
          <div className="shortcuts">{t('shortcuts')}</div>
        </section>
      </div>
      {genOpen && <GenerateDialog initialMode={genOpen} selection={selection} chunkChars={settings.chunkChars} maxChars={settings.maxInputChars} onStart={startFromDialog} onClose={() => setGenOpen(null)} />}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
