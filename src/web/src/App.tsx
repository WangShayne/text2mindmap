import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, type Doc, type DocMeta, type Me } from './api'
import { useI18n } from './i18n'
import { AuthScreen } from './components/AuthScreen'
const Workspace = lazy(() => import('./components/Workspace').then((m) => ({ default: m.Workspace })))
import { SettingsDialog } from './components/SettingsDialog'
import { AboutDialog } from './components/AboutDialog'
import { Menu } from './components/Menu'
import { APP_NAME } from '../../shared/brand'

type Boot = { state: 'loading' } | { state: 'setup' } | { state: 'login' } | { state: 'app'; me: Me }

export function App() {
  const { t, lang, setLang } = useI18n()
  const [boot, setBoot] = useState<Boot>({ state: 'loading' })
  const [docs, setDocs] = useState<DocMeta[]>([])
  const [doc, setDoc] = useState<Doc | null>(null)
  const [dialog, setDialog] = useState<null | 'settings' | 'about'>(null)
  const [settingsFocus, setSettingsFocus] = useState<'asr' | undefined>(undefined)
  const [pub, setPub] = useState<{ chunkChars: number; maxInputChars: number; configured: boolean; asr?: { configured: boolean; segmentSeconds: number } }>({ chunkChars: 12000, maxInputChars: 200000, configured: true })
  const fileInput = useRef<HTMLInputElement>(null)
  const [navOpen, setNavOpen] = useState(false)

  useEffect(() => {
    ;(async () => {
      try {
        const s = await api<{ needsSetup: boolean }>('GET', '/api/setup')
        if (s.needsSetup) return setBoot({ state: 'setup' })
        const me = await api<{ user: Me }>('GET', '/api/auth/me')
        setBoot({ state: 'app', me: me.user })
      } catch (e) {
        setBoot(e instanceof ApiError && e.status === 401 ? { state: 'login' } : { state: 'login' })
      }
    })()
  }, [])

  const loadDocs = useCallback(async () => {
    const r = await api<{ docs: DocMeta[] }>('GET', '/api/docs')
    setDocs(r.docs)
    return r.docs
  }, [])

  const openDoc = useCallback(async (id: string) => {
    const r = await api<{ doc: Doc }>('GET', `/api/docs/${id}`)
    setDoc(r.doc)
    localStorage.setItem('t2m.lastDoc', id)
  }, [])

  const createDoc = useCallback(async (title?: string, markdown?: string) => {
    const r = await api<{ doc: Doc }>('POST', '/api/docs', { title: title ?? t('untitled'), ...(markdown !== undefined ? { markdown } : {}) })
    await loadDocs()
    setDoc(r.doc)
    localStorage.setItem('t2m.lastDoc', r.doc.id)
  }, [loadDocs, t])

  useEffect(() => {
    if (boot.state !== 'app') return
    api('GET', '/api/settings/public').then(setPub).catch(() => {})
    loadDocs().then((list) => {
      const last = localStorage.getItem('t2m.lastDoc')
      const pick = list.find((d) => d.id === last) ?? list[0]
      if (pick) openDoc(pick.id)
      else createDoc()
    })
  }, [boot.state, loadDocs, openDoc, createDoc])

  const onMetaChange = useCallback((m: Partial<Doc> & { id: string }) => {
    setDocs((list) => list.map((d) => (d.id === m.id ? { ...d, ...m } : d)).sort((a, b) => b.updated_at - a.updated_at))
    setDoc((d) => (d && d.id === m.id ? { ...d, ...m } : d))
  }, [])

  const rename = async (d: DocMeta) => {
    const title = window.prompt(t('rename'), d.title)
    if (title === null) return
    const r = await api<{ doc: Doc }>('PUT', `/api/docs/${d.id}`, { title })
    onMetaChange({ id: d.id, title: r.doc.title })
  }
  const remove = async (d: DocMeta) => {
    if (!window.confirm(t('confirmDelete', { title: d.title }))) return
    await api('DELETE', `/api/docs/${d.id}`)
    const list = await loadDocs()
    if (doc?.id === d.id) { if (list[0]) openDoc(list[0].id); else { setDoc(null); createDoc() } }
  }
  const importFile = async (f: File) => {
    const text = await f.text()
    await createDoc(f.name.replace(/\.(md|markdown|txt)$/i, '') || t('untitled'), text)
  }
  const logout = async () => { await api('POST', '/api/auth/logout').catch(() => {}); setDoc(null); setDocs([]); setBoot({ state: 'login' }) }

  if (boot.state === 'loading') return <div className="center muted">…</div>
  if (boot.state === 'setup' || boot.state === 'login') return <AuthScreen mode={boot.state} onDone={(me) => setBoot({ state: 'app', me })} />

  const openDocNav = (id: string) => { setNavOpen(false); if (doc?.id !== id) openDoc(id) }
  const initial = boot.me.username.slice(0, 1).toUpperCase()

  return (
    <div className="app">
      <input ref={fileInput} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); e.target.value = '' }} />
      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}
      <aside className={`sidebar ${navOpen ? 'open' : ''}`}>
        <div className="brand"><span className="logo" />{APP_NAME}<span className="spacer" /><button className="icon-btn nav-close" title={t('close')} aria-label={t('close')} onClick={() => setNavOpen(false)}>✕</button></div>
        <button className="btn primary block" onClick={() => { setNavOpen(false); createDoc() }}>＋ {t('newDoc')}</button>
        <div className="side-label">{t('documents')}</div>
        <nav className="doc-list">
          {docs.length === 0 && <div className="muted small">{t('noDocs')}</div>}
          {docs.map((d) => (
            <div key={d.id} className={`doc-item ${doc?.id === d.id ? 'active' : ''}`} onClick={() => openDocNav(d.id)}>
              <span className="doc-title" title={d.title}>{d.title}</span>
              <span className="doc-actions">
                <button className="icon-btn" title={t('rename')} aria-label={t('rename')} onClick={(e) => { e.stopPropagation(); rename(d) }}>✎</button>
                <button className="icon-btn" title={t('delete')} aria-label={t('delete')} onClick={(e) => { e.stopPropagation(); remove(d) }}>🗑</button>
              </span>
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <div className="user-chip" title={boot.me.username}>
            <span className="avatar">{initial}</span>
            <span className="user-meta">
              <span className="user-name">{boot.me.username}</span>
              {boot.me.isAdmin && <span className="user-role">{t('adminRole')}</span>}
            </span>
          </div>
          <button className="icon-btn foot-btn" title={t('settings')} aria-label={t('settings')} data-testid="open-settings" onClick={() => { setNavOpen(false); setDialog('settings') }}>⚙</button>
          <Menu className="icon-btn foot-btn" title={t('account')} testId="account-menu" trigger="⋯" up align="right" items={[
            { key: 'lang', icon: '🌐', label: t('language'), onSelect: () => setLang(lang === 'en' ? 'zh' : 'en') },
            { key: 'about', icon: 'ⓘ', label: t('about'), onSelect: () => setDialog('about') },
            { key: 'out', icon: '⎋', label: t('signOut'), onSelect: logout, danger: true, divider: true },
          ]} />
        </div>
      </aside>
      <main className="main">
        <Suspense fallback={<div className="center muted">…</div>}>{doc ? <Workspace key={doc.id} doc={doc} onMetaChange={onMetaChange} settings={pub} onImport={() => fileInput.current?.click()} onImportDoc={async (title, md) => { await createDoc(title, md) }} onAbout={() => setDialog('about')} onToggleNav={() => setNavOpen((v) => !v)} isAdmin={boot.me.isAdmin} onOpenSettings={(section) => { setSettingsFocus(section); setDialog('settings') }} /> : <div className="center muted">…</div>}</Suspense>
      </main>
      {dialog === 'settings' && <SettingsDialog me={boot.me} focus={settingsFocus} onClose={() => { setDialog(null); setSettingsFocus(undefined); api('GET', '/api/settings/public').then(setPub).catch(() => {}) }} />}
      {dialog === 'about' && <AboutDialog onClose={() => setDialog(null)} />}
    </div>
  )
}
