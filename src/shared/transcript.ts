/**
 * Transcript slices and node -> slice references (v0.5, docs/v0.5-api-contract.md).
 *
 * A slice is one ASR request's audio segment and its text; the browser assigns the
 * ids ("s1", "s2", ...) and times. A NodeRef ties an outline node (by its path in the
 * parseMarkdown tree) to the slices it came from.
 *
 * The LLM marks the source of each outline line with `⟦s12,s13⟧`. Markers are kept
 * through validation and merging, then stripped from the text with `stripMarks`.
 */
import { cleanText, type OutlineNode } from './outline'

export interface Slice {
  id: string
  start: number
  end: number
  text: string
  take: number
  status: 'ok' | 'failed'
}

export interface NodeRef {
  path: number[]
  sliceIds: string[]
  timeRange: [number, number]
  take: number
  precision: 'slice' | 'section'
}

export interface TranscriptDoc {
  version: 1
  slices: Slice[]
  refs: NodeRef[]
}

export const MAX_SLICES = 50_000
const SLICE_ID = /^s\d{1,9}$/
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const round3 = (n: number) => Math.round(n * 1000) / 1000

/** Validates slices from a request. Returns the cleaned list, or an error message. */
export function parseSlices(x: unknown): Slice[] | string {
  if (!Array.isArray(x)) return 'slices must be an array'
  if (x.length > MAX_SLICES) return `Too many slices (max ${MAX_SLICES})`
  const seen = new Set<string>()
  const out: Slice[] = []
  for (const [i, s] of x.entries()) {
    if (!s || typeof s !== 'object') return `slices[${i}] must be an object`
    const { id, start, end, text, take = 1, status = 'ok' } = s as Record<string, unknown>
    if (typeof id !== 'string' || !SLICE_ID.test(id)) return `slices[${i}].id must look like "s1"`
    if (seen.has(id)) return `Duplicate slice id ${id}`
    if (!num(start) || !num(end) || start < 0 || end < start) return `slices[${i}] has an invalid start/end`
    if (typeof text !== 'string') return `slices[${i}].text must be a string`
    if (!Number.isInteger(take) || (take as number) < 1) return `slices[${i}].take must be a positive integer`
    if (status !== 'ok' && status !== 'failed') return `slices[${i}].status must be "ok" or "failed"`
    const prev = out.at(-1)
    if (prev && ((take as number) < prev.take || (take === prev.take && start < prev.start))) return `slices must be sorted by (take, start); see slices[${i}]`
    seen.add(id)
    out.push({ id, start: round3(start), end: round3(end), text: status === 'failed' ? '' : text, take: take as number, status })
  }
  return out
}

/** Validates refs. With `ids`, every slice id must be one of them. */
export function parseRefs(x: unknown, ids?: Set<string>): NodeRef[] | string {
  if (!Array.isArray(x)) return 'refs must be an array'
  const out: NodeRef[] = []
  for (const [i, r] of x.entries()) {
    if (!r || typeof r !== 'object') return `refs[${i}] must be an object`
    const { path, sliceIds, timeRange, take, precision } = r as Record<string, unknown>
    if (!Array.isArray(path) || path.length > 64 || !path.every((p) => Number.isInteger(p) && p >= 0)) return `refs[${i}].path must be a list of indexes`
    if (!Array.isArray(sliceIds) || !sliceIds.every((s) => typeof s === 'string' && SLICE_ID.test(s))) return `refs[${i}].sliceIds must be slice ids`
    if (ids && !sliceIds.every((s) => ids.has(s))) return `refs[${i}] points to an unknown slice`
    if (!Array.isArray(timeRange) || timeRange.length !== 2 || !timeRange.every(num)) return `refs[${i}].timeRange must be [start, end]`
    if (!Number.isInteger(take) || (take as number) < 1) return `refs[${i}].take must be a positive integer`
    if (precision !== 'slice' && precision !== 'section') return `refs[${i}].precision must be "slice" or "section"`
    out.push({ path: path as number[], sliceIds: sliceIds as string[], timeRange: [timeRange[0], timeRange[1]], take: take as number, precision })
  }
  return out
}

/** Validates a stored transcript (`documents.transcript`). */
export function parseTranscriptDoc(x: unknown): TranscriptDoc | string {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return 'transcript must be an object'
  const t = x as Record<string, unknown>
  if (t.version !== 1) return 'transcript.version must be 1'
  const slices = parseSlices(t.slices ?? [])
  if (typeof slices === 'string') return slices
  const refs = parseRefs(t.refs ?? [], new Set(slices.map((s) => s.id)))
  if (typeof refs === 'string') return refs
  return { version: 1, slices, refs }
}

export const hasText = (s: Slice) => s.status === 'ok' && s.text.trim() !== ''

/** Builds a ref from slice ids; timeRange covers the slices of the first take. */
export function makeRef(path: number[], ids: Iterable<string>, byId: Map<string, Slice>, precision: NodeRef['precision']): NodeRef | undefined {
  const ss = [...new Set(ids)].map((id) => byId.get(id)).filter((s): s is Slice => !!s).sort((a, b) => a.take - b.take || a.start - b.start)
  if (!ss.length) return undefined
  const take = ss[0].take
  const same = ss.filter((s) => s.take === take)
  return { path, sliceIds: ss.map((s) => s.id), timeRange: [Math.min(...same.map((s) => s.start)), Math.max(...same.map((s) => s.end))], take, precision }
}

/** Transcript lines as sent to the LLM: `[s12] text`. */
export function taggedText(slices: Slice[], tags: boolean): string {
  return slices.filter(hasText).map((s) => (tags ? `[${s.id}] ${s.text.trim()}` : s.text.trim())).join('\n')
}

// `⟦s1,s2⟧`, plus the input's own `[s1]` style, which models sometimes echo.
const MARK = /\s*(?:⟦|\[)\s*(s\d{1,9}(?:\s*[,，、]\s*s\d{1,9})*)\s*(?:⟧|\])/g

export function takeMarks(text: string): { text: string; ids: string[] } {
  const ids: string[] = []
  const rest = text.replace(MARK, (_, list: string) => { ids.push(...list.split(/\s*[,，、]\s*/)); return '' })
  return { text: cleanText(rest), ids }
}

export const pathKey = (p: number[]) => p.join('.')

export function walk(node: OutlineNode, fn: (n: OutlineNode, path: number[]) => void, path: number[] = []): void {
  fn(node, path)
  node.children.forEach((c, i) => walk(c, fn, [...path, i]))
}

/** Copy of the tree with markers removed, plus the marker ids of each node by path. */
export function stripMarks(root: OutlineNode): { tree: OutlineNode; marks: Map<string, string[]> } {
  const marks = new Map<string, string[]>()
  const copy = (n: OutlineNode, path: number[]): OutlineNode => {
    const m = takeMarks(n.text)
    if (m.ids.length) marks.set(pathKey(path), m.ids)
    return { text: m.text, kind: n.kind, children: n.children.map((c, i) => copy(c, [...path, i])) }
  }
  return { tree: copy(root, []), marks }
}

/** Removes `⟦…⟧` markers from streamed text, also when one is split across chunks. */
export class MarkFilter {
  private buf = ''
  push(t: string): string {
    this.buf += t
    let out = ''
    for (;;) {
      const i = this.buf.indexOf('⟦')
      if (i < 0) { out += this.buf; this.buf = ''; break }
      out += this.buf.slice(0, i)
      const j = this.buf.indexOf('⟧', i)
      if (j < 0) {
        this.buf = this.buf.slice(i)
        if (this.buf.length > 200 || this.buf.includes('\n')) { out += this.buf; this.buf = '' }
        break
      }
      this.buf = this.buf.slice(j + 1)
    }
    return out
  }
}
