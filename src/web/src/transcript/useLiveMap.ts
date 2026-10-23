import { useCallback, useRef, useState } from 'react'
import { ApiError, streamGenerate, type MapChanges } from '../api'
import type { NodeRef, Slice } from '../../../shared/transcript'

/**
 * Front-end only slice states (docs/v0.5-ui-states.md §1). The server only knows `status: 'ok' | 'failed'`;
 * a slice with a `client` state is not committed yet and is never sent.
 */
export type ClientSliceState = 'pending' | 'transcribing' | 'retrying'
export interface LiveSlice extends Slice { client?: ClientSliceState }

export type LiveStatus = 'idle' | 'sending' | 'error'

/**
 * Live map updates while recording (`mode: "incremental"`, docs/v0.5-api-contract.md §3.3).
 *
 * Committed slices that the server has not taken yet stay in `unsent` until a `done` for them arrives,
 * so a 409 busy or an error simply folds them into the next round. Results older than the last applied
 * `seq` are dropped.
 */
export function useLiveMap({ docId, title, getMarkdown, onApply, onBusy }: {
  docId: string
  title: () => string
  getMarkdown: () => string
  onApply: (markdown: string, refs: NodeRef[], changes: MapChanges) => void
  /** A manual request hit a running one (409 or still in flight). */
  onBusy: () => void
}) {
  const [slices, setSlices] = useState<LiveSlice[]>([])
  const [refs, setRefs] = useState<NodeRef[]>([])
  const [status, setStatus] = useState<LiveStatus>('idle')
  const [error, setError] = useState('')
  const slicesRef = useRef(slices)
  slicesRef.current = slices
  const refsRef = useRef(refs)
  refsRef.current = refs
  const unsent = useRef(new Set<string>())
  const seq = useRef(0)
  const applied = useRef(-1)
  const inFlight = useRef(false)
  const abort = useRef<AbortController | null>(null)

  const upsert = useCallback((s: LiveSlice) => {
    if (!s.client) unsent.current.add(s.id)
    setSlices((prev) => {
      const i = prev.findIndex((p) => p.id === s.id)
      if (i < 0) return [...prev, s]
      const next = prev.slice()
      next[i] = s
      return next
    })
  }, [])

  const send = useCallback(async (manual = false) => {
    if (inFlight.current) { if (manual) onBusy(); return } // the next round carries the new slices
    const ids = new Set(unsent.current)
    const newSlices = slicesRef.current.filter((s) => ids.has(s.id) && !s.client).map(({ client: _, ...s }) => s)
    if (!newSlices.length && !manual) return
    const mySeq = ++seq.current
    inFlight.current = true
    setStatus('sending')
    const ac = new AbortController()
    abort.current = ac
    try {
      await streamGenerate({ mode: 'incremental', docId, seq: mySeq, title: title(), markdown: getMarkdown(), refs: refsRef.current, newSlices }, (e) => {
        if (e.type === 'error') throw new ApiError(500, e.message)
        if (e.type !== 'done' || e.seq === undefined) return
        if (e.seq < applied.current) return // stale
        applied.current = e.seq
        for (const s of newSlices) unsent.current.delete(s.id)
        setRefs(e.refs ?? [])
        refsRef.current = e.refs ?? []
        onApply(e.markdown, e.refs ?? [], e.changes ?? { added: [], updated: [] })
      }, ac.signal)
      setStatus('idle')
      setError('')
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Busy: keep the slices for the next round, silently unless the user asked for it.
        if (manual) onBusy()
        setStatus('idle')
      } else if (!ac.signal.aborted) {
        setStatus('error')
        setError((e as Error).message)
      }
    } finally {
      inFlight.current = false
      abort.current = null
    }
  }, [docId, title, getMarkdown, onApply, onBusy])

  const reset = useCallback(() => {
    abort.current?.abort()
    unsent.current.clear()
    seq.current = 0
    applied.current = -1
    setSlices([])
    setRefs([])
    setStatus('idle')
    setError('')
  }, [])

  /** Marks every committed slice as already sent (slices loaded with a saved document). */
  const markSent = useCallback(() => unsent.current.clear(), [])

  return { slices, refs, setRefs, status, error, upsert, send, reset, markSent, unsentCount: () => unsent.current.size }
}
