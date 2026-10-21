import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { ASR_SAMPLE_RATE, joinTranscript, planSegments } from '../../../shared/wav'
import { MAX_AUDIO_FILE_BYTES, MicRecorder, decodeToMono16k, micSupport, transcribeWithRetry } from './voice'

export interface AsrPublic { configured: boolean; segmentSeconds: number }

export const ASR_LANGS = ['auto', 'zh', 'en', 'yue', 'ja', 'ko'] as const
export const fmtClock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export type VoiceState =
  | { kind: 'idle' }
  | { kind: 'decoding'; name: string }
  | { kind: 'file'; name: string; done: number; total: number }
  | { kind: 'recording'; since: number; pending: number }
  | { kind: 'finishing'; pending: number }

/** Appends one transcript piece to a text, starting a new paragraph for a new recording or file. */
export const appendPiece = (prev: string, piece: string, newBlock: boolean) =>
  !piece.trim() ? prev
    : newBlock && prev.trim() ? `${prev.replace(/\s+$/, '')}\n\n${piece.trim()}` : joinTranscript(prev, piece)

/**
 * Microphone recording and audio-file transcription, shared by the record panel and the
 * generate dialog. Audio is converted to 16 kHz mono WAV in the browser and sent in short
 * segments (about 8 s while recording); each recognized piece is handed to onAppend.
 */
export function useTranscriber(asr: AsrPublic, onAppend: (text: string, newBlock: boolean) => void) {
  const { t } = useI18n()
  const [state, setState] = useState<VoiceState>({ kind: 'idle' })
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [level, setLevel] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [lang, setLangState] = useState(() => localStorage.getItem('t2m.asrLang') ?? 'auto')
  const abort = useRef<AbortController | null>(null)
  const rec = useRef<MicRecorder | null>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const pending = useRef(0)
  const firstPiece = useRef(true)
  const appendRef = useRef(onAppend)
  appendRef.current = onAppend
  const langRef = useRef(lang)
  langRef.current = lang
  const mic = micSupport()
  const busy = state.kind !== 'idle'

  useEffect(() => { if (state.kind !== 'recording') return; const id = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(id) }, [state.kind])
  // Stop everything when the owner unmounts.
  useEffect(() => () => { abort.current?.abort(); void rec.current?.stop() }, [])

  const setLang = (l: string) => { setLangState(l); localStorage.setItem('t2m.asrLang', l) }
  const append = (text: string) => {
    if (!text.trim()) return
    appendRef.current(text, firstPiece.current)
    firstPiece.current = false
  }
  const fail = (e: unknown, segment?: number) => {
    if (abort.current?.signal.aborted) return
    const msg = (e as Error).message
    setError(segment !== undefined ? t('asrSegmentFailed', { i: segment, msg }) : msg)
  }

  const transcribeFile = async (f: File) => {
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
        const text = await transcribeWithRetry(samples.subarray(segs[i][0], segs[i][1]), { language: langRef.current, name: `${base}-${i + 1}`, signal: ac.signal })
        append(text)
        setState({ kind: 'file', name: f.name, done: i + 1, total: segs.length })
      } catch (e) { failed = true; fail(e, i + 1); break }
    }
    if (ac.signal.aborted) setInfo(t('asrCancelled'))
    else if (!failed) setInfo(t('asrFileDone', { dur: fmtClock(samples.length / ASR_SAMPLE_RATE) }))
    abort.current = null
    setState({ kind: 'idle' })
  }

  const startRec = async () => {
    if (rec.current) return
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
        try { append(await transcribeWithRetry(seg, { language: langRef.current, name: `rec-${idx}`, signal: ac.signal })) } catch (e) { fail(e, idx) }
        pending.current--
        setState((s) => (s.kind === 'recording' || s.kind === 'finishing' ? { ...s, pending: pending.current } : s))
      })
    }, (rms) => setLevel(Math.min(1, rms * 6)))
    rec.current = r
    setState({ kind: 'recording', since: Date.now(), pending: 0 })
    setNow(Date.now())
    try {
      await r.start()
    } catch (e) {
      rec.current = null
      setState({ kind: 'idle' })
      const name = (e as Error).name
      setError(name === 'NotAllowedError' || name === 'SecurityError' ? t('asrMicDenied') : name === 'NotFoundError' ? t('asrNoMic') : (e as Error).message)
    }
  }
  const stopRec = useCallback(async () => {
    const r = rec.current; rec.current = null
    setState({ kind: 'finishing', pending: pending.current })
    setLevel(0)
    await r?.stop()
    await queue.current
    abort.current = null
    setState({ kind: 'idle' })
  }, [])
  const cancel = () => { abort.current?.abort(); if (rec.current) void stopRec() }

  return { state, busy, error, info, level, now, lang, setLang, mic, startRec, stopRec, transcribeFile, cancel }
}
