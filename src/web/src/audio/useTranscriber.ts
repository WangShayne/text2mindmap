import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { ASR_SAMPLE_RATE, PcmFramer, floatToPcm16, joinTranscript, planSegments } from '../../../shared/wav'
import { MAX_AUDIO_FILE_BYTES, MicRecorder, decodeToMono16k, micSupport, transcribeWithRetry } from './voice'
import { HeldSegments, LiveCaptions, RealtimeClient, realtimeUrl, type DegradeReason } from './realtime'

export interface AsrPublic {
  configured: boolean
  segmentSeconds: number
  /** Live captions over /api/realtime are available. */
  realtime?: boolean
  /** true (default): captions only, the text comes from the segmented model. false: realtime finals are the text. */
  realtimeTwoPass?: boolean
}

/** How far a realtime final may lag behind the audio it covers (ms); used to line captions up with segments. */
const CAPTION_LAG_MS = 2000

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
 *
 * With live captions (asr.realtime) the same microphone audio is also streamed to /api/realtime.
 * Two-pass (default): captions are shown while speaking and each segment's text from the segmented
 * model replaces them. Single-pass: realtime finals are appended as the text. Either way, when the
 * realtime session ends abnormally (idle 1001, busy 1008, too long 1009, network / 1006) recording goes
 * on with segmented recognition only and a short notice says why.
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
  const rt = useRef<RealtimeClient | null>(null)
  const liveFlush = useRef<(() => void) | null>(null)
  const captionsRef = useRef(new LiveCaptions())
  const [captions, setCaptions] = useState({ done: '', partial: '' })
  const [live, setLive] = useState(false)
  const [notice, setNotice] = useState('')
  const showCaptions = () => setCaptions(captionsRef.current.view(joinTranscript))
  const mic = micSupport()
  const busy = state.kind !== 'idle'

  useEffect(() => { if (state.kind !== 'recording') return; const id = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(id) }, [state.kind])
  // Stop everything when the owner unmounts.
  useEffect(() => () => { abort.current?.abort(); rt.current?.close(); void rec.current?.stop() }, [])
  useEffect(() => { if (notice) { const id = setTimeout(() => setNotice(''), 6000); return () => clearTimeout(id) } }, [notice])

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
    setError(''); setInfo(''); setNotice('')
    const ac = new AbortController(); abort.current = ac
    firstPiece.current = true
    pending.current = 0
    queue.current = Promise.resolve()
    captionsRef.current.clear(); showCaptions()
    let n = 0
    const twoPass = asr.realtimeTwoPass !== false
    // Single-pass only: segments cut while realtime finals are the text, kept until a final covers them
    // so they can still go to the segmented model if live captions drop out.
    const held = new HeldSegments<{ samples: Float32Array; at: number }>(CAPTION_LAG_MS)

    const transcribeSegment = (seg: Float32Array, at: number) => {
      const idx = ++n
      pending.current++
      setState((s) => (s.kind === 'recording' || s.kind === 'finishing' ? { ...s, pending: pending.current } : s))
      queue.current = queue.current.then(async () => {
        if (ac.signal.aborted) return
        try {
          append(await transcribeWithRetry(seg, { language: langRef.current, name: `rec-${idx}`, signal: ac.signal }))
          // This segment's text replaces the live captions for the same stretch of audio.
          captionsRef.current.dropUntil(at + CAPTION_LAG_MS); showCaptions()
        } catch (e) { fail(e, idx) }
        pending.current--
        setState((s) => (s.kind === 'recording' || s.kind === 'finishing' ? { ...s, pending: pending.current } : s))
      })
    }

    let client: RealtimeClient | null = null
    if (asr.realtime && typeof WebSocket !== 'undefined') {
      client = new RealtimeClient(realtimeUrl(), {
        onReady: () => setLive(true),
        onPartial: (seg, text) => { captionsRef.current.setPartial(seg, text); showCaptions() },
        onFinal: (seg, text) => {
          const at = Date.now()
          if (twoPass) { captionsRef.current.addFinal(seg, text, at); showCaptions(); return }
          captionsRef.current.addFinal(seg, '', at); showCaptions()
          held.final(at)
          queue.current = queue.current.then(() => append(text))
        },
        onDegrade: (reason: DegradeReason) => {
          if (rt.current === client) rt.current = null
          setLive(false)
          captionsRef.current.clear(); showCaptions()
          if (ac.signal.aborted) return
          setNotice(t(`rtDegrade_${reason}` as never))
          // Audio not covered by a realtime final goes to the segmented model (may repeat a few words).
          if (!twoPass) for (const h of held.take()) transcribeSegment(h.samples, h.at)
        },
      })
      rt.current = client
      client.connect()
    }
    const framer = new PcmFramer(3200, (f) => rt.current?.sendPcm(f))
    const r = new MicRecorder(Math.min(8, asr.segmentSeconds), (seg) => {
      const at = Date.now()
      if (!twoPass && rt.current) { held.push({ samples: seg, at }, at); return }
      transcribeSegment(seg, at)
    }, (rms) => setLevel(Math.min(1, rms * 6)), client ? (x) => { if (rt.current) framer.push(floatToPcm16(x)) } : undefined)
    rec.current = r
    liveFlush.current = () => framer.flush()
    setState({ kind: 'recording', since: Date.now(), pending: 0 })
    setNow(Date.now())
    try {
      await r.start()
    } catch (e) {
      rec.current = null
      rt.current?.close(); rt.current = null; setLive(false)
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
    const client = rt.current
    if (client) {
      if (asr.realtimeTwoPass !== false) client.close() // the segmented model has the final text
      else { liveFlush.current?.(); await client.stop() } // its last final is the end of the text
    }
    rt.current = null
    setLive(false)
    await queue.current
    captionsRef.current.clear(); showCaptions()
    abort.current = null
    setState({ kind: 'idle' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asr.realtimeTwoPass])
  const cancel = () => { abort.current?.abort(); rt.current?.close(); rt.current = null; if (rec.current) void stopRec() }

  return { state, busy, error, info, level, now, lang, setLang, mic, startRec, stopRec, transcribeFile, cancel, captions, live, notice, dismissNotice: () => setNotice('') }
}
