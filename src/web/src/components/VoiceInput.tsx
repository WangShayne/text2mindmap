import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { ASR_SAMPLE_RATE, planSegments } from '../../../shared/wav'
import { MAX_AUDIO_FILE_BYTES, MicRecorder, decodeToMono16k, micSupport, transcribeWithRetry } from '../audio/voice'

export interface AsrPublic { configured: boolean; segmentSeconds: number }

const LANGS = ['auto', 'zh', 'en', 'yue', 'ja', 'ko'] as const
const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`

type State =
  | { kind: 'idle' }
  | { kind: 'decoding'; name: string }
  | { kind: 'file'; name: string; done: number; total: number }
  | { kind: 'recording'; since: number; pending: number }
  | { kind: 'finishing'; pending: number }

/**
 * Voice input for the generate dialog: upload an audio file or record from the microphone.
 * Everything is converted to 16 kHz mono WAV in the browser and sent in short segments;
 * the text is appended to the dialog's text area via onAppend.
 */
export function VoiceInput({ asr, onAppend, onBusy, isAdmin = false, onOpenSettings }: {
  asr: AsrPublic
  onAppend: (text: string, newBlock: boolean) => void
  onBusy?: (busy: boolean) => void
  isAdmin?: boolean
  /** Opens Settings scrolled to the speech recognition section (admins only). */
  onOpenSettings?: () => void
}) {
  const { t } = useI18n()
  const [state, setState] = useState<State>({ kind: 'idle' })
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [level, setLevel] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [lang, setLang] = useState(() => localStorage.getItem('t2m.asrLang') ?? 'auto')
  const fileRef = useRef<HTMLInputElement>(null)
  const abort = useRef<AbortController | null>(null)
  const rec = useRef<MicRecorder | null>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const pending = useRef(0)
  const firstPiece = useRef(true)
  const mic = micSupport()
  const busy = state.kind !== 'idle'

  useEffect(() => { onBusy?.(busy) }, [busy, onBusy])
  useEffect(() => { if (state.kind !== 'recording') return; const id = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(id) }, [state.kind])
  // Stop everything when the dialog closes.
  useEffect(() => () => { abort.current?.abort(); void rec.current?.stop() }, [])

  const append = (text: string) => {
    if (!text.trim()) return
    onAppend(text, firstPiece.current)
    firstPiece.current = false
  }
  const fail = (e: unknown, segment?: number) => {
    if (abort.current?.signal.aborted) return
    const msg = (e as Error).message
    setError(segment !== undefined ? t('asrSegmentFailed', { i: segment, msg }) : msg)
  }

  // ---------- file ----------
  const onFile = async (f: File) => {
    setError(''); setInfo('')
    if (f.size > MAX_AUDIO_FILE_BYTES) return setError(t('asrFileTooBig', { mb: Math.round(MAX_AUDIO_FILE_BYTES / 1048576) }))
    const ac = new AbortController(); abort.current = ac
    firstPiece.current = true
    setState({ kind: 'decoding', name: f.name })
    let samples: Float32Array
    try { samples = await decodeToMono16k(f) } catch {
      setState({ kind: 'idle' }); return setError(t('asrDecodeFailed', { name: f.name }))
    }
    const segs = planSegments(samples, ASR_SAMPLE_RATE, asr.segmentSeconds)
    setState({ kind: 'file', name: f.name, done: 0, total: segs.length })
    const base = f.name.replace(/\.[^.]*$/, '')
    let failed = false
    for (let i = 0; i < segs.length; i++) {
      if (ac.signal.aborted) break
      try {
        const text = await transcribeWithRetry(samples.subarray(segs[i][0], segs[i][1]), { language: lang, name: `${base}-${i + 1}`, signal: ac.signal })
        append(text)
        setState({ kind: 'file', name: f.name, done: i + 1, total: segs.length })
      } catch (e) { failed = true; fail(e, i + 1); break }
    }
    if (ac.signal.aborted) setInfo(t('asrCancelled'))
    else if (!failed) setInfo(t('asrFileDone', { dur: fmt(samples.length / ASR_SAMPLE_RATE) }))
    abort.current = null
    setState({ kind: 'idle' })
  }

  // ---------- microphone ----------
  const startRec = async () => {
    setError(''); setInfo('')
    const ac = new AbortController(); abort.current = ac
    firstPiece.current = true
    pending.current = 0
    queue.current = Promise.resolve()
    let n = 0
    const r = new MicRecorder(Math.min(8, asr.segmentSeconds), (seg) => {
      const idx = ++n
      pending.current++
      setState((s) => (s.kind === 'recording' || s.kind === 'finishing' ? { ...s, pending: pending.current } : s))
      queue.current = queue.current.then(async () => {
        if (ac.signal.aborted) return
        try { append(await transcribeWithRetry(seg, { language: lang, name: `rec-${idx}`, signal: ac.signal })) } catch (e) { fail(e, idx) }
        pending.current--
        setState((s) => (s.kind === 'recording' || s.kind === 'finishing' ? { ...s, pending: pending.current } : s))
      })
    }, (rms) => setLevel(Math.min(1, rms * 6)))
    try {
      await r.start()
    } catch (e) {
      const name = (e as Error).name
      setError(name === 'NotAllowedError' || name === 'SecurityError' ? t('asrMicDenied') : name === 'NotFoundError' ? t('asrNoMic') : (e as Error).message)
      return
    }
    rec.current = r
    setState({ kind: 'recording', since: Date.now(), pending: 0 })
  }
  const stopRec = async () => {
    const r = rec.current; rec.current = null
    setState({ kind: 'finishing', pending: pending.current })
    setLevel(0)
    await r?.stop()
    await queue.current
    abort.current = null
    setState({ kind: 'idle' })
  }
  const cancel = () => { abort.current?.abort(); if (rec.current) void stopRec() }

  const off = !asr.configured
  const recTitle = off ? t('asrConfigureFirst') : mic === 'insecure' ? t('asrNeedHttps') : mic === 'unsupported' ? t('asrNoMicApi') : t('asrRecordHint')

  return (
    <div className="voice">
      <div className={`voice-bar${off ? ' off' : ''}`}>
        {state.kind === 'recording' ? (
          <>
            <button className="btn danger" data-testid="rec-stop" onClick={stopRec}>■ {t('asrStop')}</button>
            <span className="rec-dot" />
            <span className="rec-time">{fmt((now - state.since) / 1000)}</span>
            <span className="level"><span style={{ width: `${Math.round(level * 100)}%` }} /></span>
            <span className="muted small">{state.pending ? t('asrPending', { n: state.pending }) : t('asrListening')}</span>
          </>
        ) : state.kind === 'finishing' ? (
          <><span className="spinner sm" /><span className="muted small">{t('asrFinishing', { n: state.pending })}</span></>
        ) : state.kind === 'decoding' ? (
          <><span className="spinner sm" /><span className="muted small">{t('asrDecoding', { name: state.name })}</span><button className="btn small" onClick={cancel}>{t('cancel')}</button></>
        ) : state.kind === 'file' ? (
          <>
            <span className="spinner sm" />
            <span className="muted small">{t('asrProgress', { i: Math.min(state.done + 1, state.total), n: state.total })}</span>
            <span className="progress"><span style={{ width: `${Math.round((state.done / state.total) * 100)}%` }} /></span>
            <button className="btn small" onClick={cancel}>{t('cancel')}</button>
          </>
        ) : (
          <>
            {/* Disabled controls get no mouse events in some browsers, so the tooltip sits on a wrapper. */}
            <span className="tip-wrap" title={recTitle}>
              <button className="btn" data-testid="rec-start" disabled={off || mic !== 'ok'} title={recTitle} aria-label={`${t('asrRecord')}: ${recTitle}`} onClick={startRec}>🎙 {t('asrRecord')}</button>
            </span>
            <span className="tip-wrap" title={off ? t('asrConfigureFirst') : t('asrUploadHint')}>
              <button className="btn" data-testid="audio-upload" disabled={off} title={off ? t('asrConfigureFirst') : t('asrUploadHint')} onClick={() => fileRef.current?.click()}>⇪ {t('asrUpload')}</button>
            </span>
            <span className="tip-wrap" title={off ? t('asrConfigureFirst') : t('asrLanguage')}>
              <select className="lang-select" value={lang} disabled={off} title={off ? t('asrConfigureFirst') : t('asrLanguage')} aria-label={t('asrLanguage')} onChange={(e) => { setLang(e.target.value); localStorage.setItem('t2m.asrLang', e.target.value) }}>
                {LANGS.map((l) => <option key={l} value={l}>{t(`asrLang_${l}` as never)}</option>)}
              </select>
            </span>
            {off ? (
              <span className="small grow voice-hint muted" data-testid="asr-off-hint">
                {isAdmin && onOpenSettings
                  ? <>{t('asrOffAdmin')} <button type="button" className="link" data-testid="asr-open-settings" onClick={onOpenSettings}>{t('asrOpenSettings')}</button></>
                  : t('asrOffUser')}
              </span>
            ) : (
              <span className="muted small grow voice-hint">{mic === 'insecure' ? t('asrNeedHttps') : t('asrHint')}</span>
            )}
          </>
        )}
        <input ref={fileRef} type="file" hidden accept="audio/*,video/webm,video/mp4,.mp3,.m4a,.wav,.webm,.ogg,.oga,.opus,.flac,.aac,.mp4" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void onFile(f) }} />
      </div>
      {error && <div className="error small" data-testid="asr-error">{error}</div>}
      {!error && info && <div className="hint">{info}</div>}
    </div>
  )
}
