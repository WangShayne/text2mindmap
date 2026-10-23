import type { NodeRef, TranscriptDoc } from '../../shared/transcript'

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined || method !== 'GET' ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : method !== 'GET' ? '{}' : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText)
  return data as T
}

export interface DocMeta { id: string; title: string; created_at: number; updated_at: number }
export interface Doc extends DocMeta { markdown: string; transcript?: TranscriptDoc | null }
export interface Me { id: number; username: string; isAdmin: boolean }

/** `changes` paths of an incremental update (docs/v0.5-api-contract.md §3.3). */
export interface MapChanges { added: number[][]; updated: number[][] }

export type GenEvent =
  | { type: 'start'; chunks?: number; seq?: number; slices?: number }
  | { type: 'progress'; stage: 'chunk' | 'section' | 'merge'; index?: number; total?: number; timeRange?: [number, number] }
  | { type: 'section_done'; index: number; total: number; markdown: string; refs: NodeRef[] }
  | { type: 'delta'; text: string }
  | { type: 'retry'; reason: string }
  | { type: 'done'; markdown: string; refs?: NodeRef[]; seq?: number; changes?: MapChanges }
  | { type: 'error'; code: string; message: string; seq?: number; index?: number }

/** POSTs to /api/generate and calls onEvent for each SSE event. Abort with the signal. */
export async function streamGenerate(body: unknown, onEvent: (e: GenEvent) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch('/api/generate', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal })
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}))
    throw new ApiError(res.status, data.error ?? res.statusText)
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n')
      if (!data) continue
      let ev: GenEvent
      try { ev = JSON.parse(data) } catch { continue }
      onEvent(ev)
    }
  }
}
