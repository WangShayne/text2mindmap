import { useEffect, useRef, useState } from 'react'
import { api, type Me } from '../api'
import { useI18n } from '../i18n'
import { Modal } from './Modal'
import { ModelPicker } from './ModelPicker'

interface SettingsView {
  llm: { baseUrl: string; model: string; hasApiKey: boolean; keySource: 'settings' | 'env' | 'none' }
  env: { baseUrl: string; model: string; hasApiKey: boolean }
  systemPrompt: string
  systemPromptIsDefault: boolean
  defaultSystemPrompt: string
  asr: { baseUrl: string; model: string; hasApiKey: boolean; keySource: 'settings' | 'env' | 'none'; segmentSeconds: number; env: { baseUrl: string; model: string; hasApiKey: boolean; segmentSeconds: number }; maxUploadMb: number }
  realtime: { url: string; twoPass: boolean; hasApiKey: boolean; maxSeconds: number; idleSeconds: number; maxSessions: number; env: { url: string; twoPass: boolean } }
}

export function SettingsDialog({ me, onClose, focus }: { me: Me; onClose: () => void; focus?: 'asr' }) {
  const asrRef = useRef<HTMLHeadingElement>(null)
  const { t } = useI18n()
  const [view, setView] = useState<SettingsView | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [prompt, setPrompt] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [asr, setAsr] = useState({ baseUrl: '', model: '', apiKey: '', segmentSeconds: '28' })
  const [asrMsg, setAsrMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [asrTesting, setAsrTesting] = useState(false)
  const [rt, setRt] = useState({ url: '', twoPass: true })
  const [rtMsg, setRtMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [rtTesting, setRtTesting] = useState(false)
  const [pw, setPw] = useState({ current: '', next: '' })
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = (v: SettingsView) => { setView(v); setBaseUrl(v.llm.baseUrl); setModel(v.llm.model); setPrompt(v.systemPrompt); setApiKey('') }
  const loadAsr = (v: SettingsView) => { setView(v); setAsr({ baseUrl: v.asr.baseUrl, model: v.asr.model, apiKey: '', segmentSeconds: String(v.asr.segmentSeconds) }); setRt({ url: v.realtime.url, twoPass: v.realtime.twoPass }) }
  useEffect(() => { if (me.isAdmin) api<SettingsView>('GET', '/api/settings').then((v) => { load(v); loadAsr(v) }).catch((e) => setMsg({ ok: false, text: e.message })) }, [me.isAdmin])

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
  // Opened from the voice input: jump to the ASR section once the form is rendered.
  useEffect(() => {
    if (focus !== 'asr' || !view || !asrRef.current) return
    asrRef.current.scrollIntoView({ block: 'start' })
    asrRef.current.parentElement?.querySelector<HTMLInputElement>('[data-testid=asr-base-url]')?.focus({ preventScroll: true })
  }, [focus, view])
  const saveAsr = async (extra: Record<string, unknown> = {}) => {
    try {
      const v = await api<SettingsView>('PUT', '/api/settings', { asrBaseUrl: asr.baseUrl, asrModel: asr.model, asrSegmentSeconds: asr.segmentSeconds, asrRealtimeUrl: rt.url, asrRealtimeTwoPass: rt.twoPass, ...(asr.apiKey ? { asrApiKey: asr.apiKey } : {}), ...extra })
      loadAsr(v)
      setAsrMsg({ ok: true, text: t('settingsSaved') })
    } catch (e) { setAsrMsg({ ok: false, text: (e as Error).message }) }
  }
  const testAsr = async () => {
    setAsrTesting(true); setAsrMsg(null)
    try {
      const r = await api<{ ok: boolean; text?: string; code?: string; message?: string; latencyMs?: number }>('POST', '/api/settings/asr/test', { baseUrl: asr.baseUrl, model: asr.model, apiKey: asr.apiKey })
      setAsrMsg(r.ok ? { ok: true, text: t('asrTestOk', { ms: r.latencyMs ?? 0, text: r.text ? `「${r.text.slice(0, 40)}」` : t('asrTestEmpty') }) } : { ok: false, text: `[${r.code}] ${r.message}` })
    } catch (e) { setAsrMsg({ ok: false, text: (e as Error).message }) } finally { setAsrTesting(false) }
  }
  const testRt = async () => {
    setRtTesting(true); setRtMsg(null)
    try {
      const r = await api<{ ok: boolean; code?: string; message: string; latencyMs?: number }>('POST', '/api/settings/asr/realtime/test', { url: rt.url })
      setRtMsg(r.ok ? { ok: true, text: t('rtTestOk', { ms: r.latencyMs ?? 0 }) } : { ok: false, text: `[${r.code}] ${r.message}` })
    } catch (e) { setRtMsg({ ok: false, text: (e as Error).message }) } finally { setRtTesting(false) }
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
            <div className="field">
              <div className="field-label">{t('model')}</div>
              <ModelPicker value={model} onChange={setModel} baseUrl={baseUrl} apiKey={apiKey} placeholder="gpt-4o-mini" />
            </div>
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

            <h3 className="section-gap" ref={asrRef} id="settings-asr">{t('asrSection')}</h3>
            <div className="hint">{t('asrSectionHint')}</div>
            <label>{t('baseUrl')}<input data-testid="asr-base-url" value={asr.baseUrl} onChange={(e) => setAsr({ ...asr, baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" /></label>
            {view.asr.env.baseUrl && <div className="hint">{t('envDefault', { v: view.asr.env.baseUrl })}</div>}
            <div className="field">
              <div className="field-label">{t('model')}</div>
              <ModelPicker value={asr.model} onChange={(m) => setAsr((a) => ({ ...a, model: m }))} baseUrl={asr.baseUrl} apiKey={asr.apiKey} placeholder="gpt-transcribe / SenseVoiceSmall / Ming-3.0-asr-tiny" endpoint="/api/settings/asr/models" testId="asr-model" />
            </div>
            <label>{t('apiKey')}<input type="password" autoComplete="off" value={asr.apiKey} onChange={(e) => setAsr({ ...asr, apiKey: e.target.value })} placeholder={t('asrKeyPlaceholder')} /></label>
            <div className="hint">
              {view.asr.hasApiKey ? t('apiKeySet', { source: view.asr.keySource === 'settings' ? 'settings' : 'ASR_API_KEY' }) : t('apiKeyNone')}
              {view.asr.keySource === 'settings' && <button className="link" onClick={() => saveAsr({ clearAsrApiKey: true })}>{t('clearKey')}</button>}
            </div>
            <label>{t('asrSegment')}
              <span className="row gap"><input type="number" min={5} max={600} step={1} className="num" value={asr.segmentSeconds} onChange={(e) => setAsr({ ...asr, segmentSeconds: e.target.value })} /> <span className="muted">{t('seconds')}</span></span>
            </label>
            <div className="hint">{t('asrSegmentHint', { mb: view.asr.maxUploadMb })}</div>
            <h4 className="section-gap">{t('rtSection')}</h4>
            <div className="hint">{t('rtSectionHint')}</div>
            <label>{t('rtUrl')}<input data-testid="rt-url" value={rt.url} onChange={(e) => setRt({ ...rt, url: e.target.value })} placeholder="ws://sensevoice:8040/v1/realtime?intent=transcription" /></label>
            {view.realtime.env.url && <div className="hint">{t('envDefault', { v: view.realtime.env.url })}</div>}
            <label className="checkbox-row"><input type="checkbox" data-testid="rt-two-pass" checked={rt.twoPass} onChange={(e) => setRt({ ...rt, twoPass: e.target.checked })} /> {t('rtTwoPass')}</label>
            <div className="hint">{t('rtTwoPassHint')}</div>
            <div className="row gap">
              <button className="btn" data-testid="rt-test" onClick={testRt} disabled={rtTesting || !rt.url.trim()}>{rtTesting ? t('testing') : t('testConnection')}</button>
            </div>
            {rtMsg && <div className={rtMsg.ok ? 'ok-msg' : 'error'} data-testid="rt-msg">{rtMsg.text}</div>}
            <div className="row gap">
              <button className="btn primary" data-testid="asr-save" onClick={() => saveAsr()}>{t('save')}</button>
              <button className="btn" data-testid="asr-test" onClick={testAsr} disabled={asrTesting}>{asrTesting ? t('testing') : t('testConnection')}</button>
            </div>
            {asrMsg && <div className={asrMsg.ok ? 'ok-msg' : 'error'} data-testid="asr-msg">{asrMsg.text}</div>}
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
