import { useEffect, useState } from 'react'
import { api, type Me } from '../api'
import { useI18n } from '../i18n'
import { Modal } from './Modal'

interface SettingsView {
  llm: { baseUrl: string; model: string; hasApiKey: boolean; keySource: 'settings' | 'env' | 'none' }
  env: { baseUrl: string; model: string; hasApiKey: boolean }
  systemPrompt: string
  systemPromptIsDefault: boolean
  defaultSystemPrompt: string
}

export function SettingsDialog({ me, onClose }: { me: Me; onClose: () => void }) {
  const { t } = useI18n()
  const [view, setView] = useState<SettingsView | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [prompt, setPrompt] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [pw, setPw] = useState({ current: '', next: '' })
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = (v: SettingsView) => { setView(v); setBaseUrl(v.llm.baseUrl); setModel(v.llm.model); setPrompt(v.systemPrompt); setApiKey('') }
  useEffect(() => { if (me.isAdmin) api<SettingsView>('GET', '/api/settings').then(load).catch((e) => setMsg({ ok: false, text: e.message })) }, [me.isAdmin])

  const save = async (extra: Record<string, unknown> = {}) => {
    try {
      const v = await api<SettingsView>('PUT', '/api/settings', { baseUrl, model, systemPrompt: prompt, ...(apiKey ? { apiKey } : {}), ...extra })
      load(v)
      setMsg({ ok: true, text: t('settingsSaved') })
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }) }
  }
  const test = async () => {
    setTesting(true); setMsg(null)
    try {
      const r = await api<{ ok: boolean; message: string; code?: string }>('POST', '/api/settings/test', { baseUrl, model, apiKey })
      setMsg({ ok: r.ok, text: (r.code ? `[${r.code}] ` : '') + r.message })
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }) } finally { setTesting(false) }
  }
  const changePw = async () => {
    try { await api('POST', '/api/auth/password', pw); setPw({ current: '', next: '' }); setPwMsg({ ok: true, text: t('passwordChanged') }) } catch (e) { setPwMsg({ ok: false, text: (e as Error).message }) }
  }

  return (
    <Modal title={t('settings')} onClose={onClose} wide>
      {me.isAdmin ? (
        view && (
          <section>
            <h3>{t('llmSection')}</h3>
            <label>{t('baseUrl')}<input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" /></label>
            <div className="hint">{t('envDefault', { v: view.env.baseUrl })}</div>
            <label>{t('model')}<input value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o-mini" /></label>
            <div className="hint">{t('envDefault', { v: view.env.model })}</div>
            <label>{t('apiKey')}<input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" /></label>
            <div className="hint">
              {view.llm.hasApiKey ? t('apiKeySet', { source: view.llm.keySource === 'settings' ? 'settings' : 'LLM_API_KEY' }) : t('apiKeyNone')}
              {view.llm.keySource === 'settings' && <button className="link" onClick={() => save({ clearApiKey: true })}>{t('clearKey')}</button>}
            </div>
            <label>
              <span className="row between">{t('systemPrompt')} <span className="muted small">{view.systemPromptIsDefault ? t('promptDefault') : t('promptCustom')}</span></span>
              <textarea rows={10} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            </label>
            <div className="row gap">
              <button className="btn primary" onClick={() => save()}>{t('save')}</button>
              <button className="btn" onClick={test} disabled={testing}>{testing ? t('testing') : t('testConnection')}</button>
              <button className="btn ghost" onClick={() => { setPrompt(view.defaultSystemPrompt); save({ resetSystemPrompt: true, systemPrompt: undefined }) }}>{t('resetDefault')}</button>
            </div>
            {msg && <div className={msg.ok ? 'ok-msg' : 'error'}>{msg.text}</div>}
          </section>
        )
      ) : (
        <p className="muted">{t('adminOnly')}</p>
      )}
      <section>
        <h3>{t('changePassword')}</h3>
        <div className="row gap">
          <input type="password" autoComplete="current-password" placeholder={t('currentPassword')} value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          <input type="password" autoComplete="new-password" placeholder={t('newPassword')} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          <button className="btn" onClick={changePw} disabled={!pw.current || !pw.next}>{t('save')}</button>
        </div>
        {pwMsg && <div className={pwMsg.ok ? 'ok-msg' : 'error'}>{pwMsg.text}</div>}
      </section>
    </Modal>
  )
}
