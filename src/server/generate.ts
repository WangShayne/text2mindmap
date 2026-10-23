import { cleanText, countNodes, normalizeMarkdown, parseMarkdown, serializeOutline, stripThink, type OutlineNode } from '../shared/outline'
import { MarkFilter, hasText, makeRef, pathKey, stripMarks, taggedText, walk, type NodeRef, type Slice } from '../shared/transcript'
import { splitText } from './chunk'
import {
  DEFAULT_SYSTEM_PROMPT, EXPAND_SYSTEM_PROMPT, INCREMENTAL_SYSTEM_PROMPT, chunkUserPrompt, expandUserPrompt, incrementalUserPrompt, mergeUserPrompt, sectionUserPrompt,
  transcriptMergePrompt,
} from './prompts'
import { LlmError, streamChat, type LlmConfig } from './llm'

export interface SectionInfo { index: number; sliceIds: [string, string]; timeRange: [number, number] }
export interface Changes { added: number[][]; updated: number[][] }

export type GenEvent =
  | { type: 'start'; chunks: number; sections?: SectionInfo[] }
  | { type: 'start'; seq: number; slices: number }
  | { type: 'progress'; stage: 'chunk' | 'merge' | 'section'; index?: number; total?: number; timeRange?: [number, number] }
  | { type: 'section_done'; index: number; total: number; markdown: string; refs: NodeRef[] }
  | { type: 'delta'; text: string }
  | { type: 'retry'; reason: string }
  | { type: 'done'; markdown: string; refs?: NodeRef[]; seq?: number; changes?: Changes }
  | { type: 'error'; code: string; message: string; index?: number; seq?: number }

export interface Validation { ok: boolean; reason?: string; markdown: string }

const MARKUP_LINE = /^\s*(#{1,6}(\s|$)|[-*+](\s|$)|\d{1,9}[.)](\s|$))/

/** Checks that LLM output is a usable outline and returns its normalized form. */
export function validateOutline(raw: string, fallbackTitle: string, opts: { requireTitle: boolean; minNodes: number }): Validation {
  const body = stripThink(raw).split('\n').filter((l) => l.trim() && !/^\s*(```|~~~)/.test(l))
  if (!body.length) return { ok: false, reason: 'empty output', markdown: '' }
  const markup = body.filter((l) => MARKUP_LINE.test(l)).length
  if (markup / body.length < 0.6) return { ok: false, reason: `output is mostly prose (${markup}/${body.length} lines are headings or bullets)`, markdown: '' }
  if (opts.requireTitle && !body.some((l) => /^\s{0,3}#\s/.test(l))) return { ok: false, reason: 'missing "# " title', markdown: '' }
  const tree = parseMarkdown(raw, fallbackTitle)
  if (countNodes(tree) < opts.minNodes) return { ok: false, reason: 'too few nodes', markdown: '' }
  return { ok: true, markdown: serializeOutline(tree) }
}

interface Ctx { cfg: LlmConfig; systemPrompt?: string; chunkChars: number; signal?: AbortSignal; emit: (e: GenEvent) => void }

async function withRetry(ctx: Ctx, run: (stream: boolean) => Promise<string>, check: (raw: string) => Validation, stream: boolean): Promise<string> {
  let last: Validation | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) ctx.emit({ type: 'retry', reason: last?.reason ?? 'invalid output' })
    const raw = await run(stream)
    last = check(raw)
    if (last.ok) return last.markdown
  }
  throw new LlmError('bad_response', `The model's answer was not a valid outline (${last?.reason}) after one retry. Try again, or try another model.`)
}

export async function generateOutline(ctx: Ctx, text: string, title = 'Untitled'): Promise<string> {
  const system = ctx.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT
  const chunks = splitText(text, ctx.chunkChars)
  if (!chunks.length) throw new LlmError('bad_response', 'The input text is empty.')
  ctx.emit({ type: 'start', chunks: chunks.length })
  const deltas = (on: boolean) => (t: string) => { if (on) ctx.emit({ type: 'delta', text: t }) }
  const check = (raw: string) => validateOutline(raw, title, { requireTitle: false, minNodes: 3 })

  if (chunks.length === 1) {
    const md = await withRetry(ctx, (s) => streamChat(ctx.cfg, [{ role: 'system', content: system }, { role: 'user', content: chunks[0] }], deltas(s), ctx.signal), check, true)
    ctx.emit({ type: 'done', markdown: md })
    return md
  }

  const outlines: string[] = []
  for (let i = 0; i < chunks.length; i++) {
    ctx.emit({ type: 'progress', stage: 'chunk', index: i + 1, total: chunks.length })
    const msgs = [{ role: 'system' as const, content: system }, { role: 'user' as const, content: chunkUserPrompt(chunks[i], i, chunks.length) }]
    outlines.push(await withRetry(ctx, () => streamChat(ctx.cfg, msgs, () => {}, ctx.signal), (r) => validateOutline(r, `Part ${i + 1}`, { requireTitle: false, minNodes: 2 }), false))
  }
  ctx.emit({ type: 'progress', stage: 'merge' })
  const mergeMsgs = [{ role: 'system' as const, content: system }, { role: 'user' as const, content: mergeUserPrompt(outlines) }]
  const md = await withRetry(ctx, (s) => streamChat(ctx.cfg, mergeMsgs, deltas(s), ctx.signal), check, true)
  ctx.emit({ type: 'done', markdown: md })
  return md
}

/** Generates new children for one node. Returns a nested bullet list (Markdown). */
export async function expandNode(ctx: Ctx, docMarkdown: string, path: string[], existingChildren: string[], extra?: string): Promise<string> {
  ctx.emit({ type: 'start', chunks: 1 })
  const msgs = [{ role: 'system' as const, content: EXPAND_SYSTEM_PROMPT }, { role: 'user' as const, content: expandUserPrompt(path, existingChildren, docMarkdown.slice(0, ctx.chunkChars), extra) }]
  const check = (raw: string): Validation => {
    const v = validateOutline(`# x\n${raw.replace(/^\s*#{1,6}\s+/gm, '- ')}`, 'x', { requireTitle: false, minNodes: 2 })
    if (!v.ok) return v
    const tree = parseMarkdown(v.markdown)
    const md = tree.children.map((c) => serializeOutline({ text: '', kind: 'heading', children: [{ ...c, kind: 'list' }] }).split('\n').slice(2).join('\n')).join('')
    return { ok: true, markdown: md.trim() + '\n' }
  }
  const md = await withRetry(ctx, (s) => streamChat(ctx.cfg, msgs, (t) => { if (s) ctx.emit({ type: 'delta', text: t }) }, ctx.signal), check, true)
  ctx.emit({ type: 'done', markdown: md })
  return md
}

// ---------- v0.5: transcript (sections + merge) and incremental ----------

/** Groups consecutive slices into sections of at most `seconds` and `maxChars`; a new take starts a new section. Sections without text are dropped. */
export function planSections(slices: Slice[], seconds: number, maxChars: number, tags = true): Slice[][] {
  const groups: Slice[][] = []
  let cur: Slice[] = []
  let chars = 0
  for (const s of slices) {
    const len = hasText(s) ? taggedText([s], tags).length + 1 : 0
    const first = cur[0]
    if (first && (s.take !== first.take || s.end - first.start > seconds || (chars > 0 && chars + len > maxChars))) { groups.push(cur); cur = []; chars = 0 }
    cur.push(s)
    chars += len
  }
  if (cur.length) groups.push(cur)
  return groups.filter((g) => g.some(hasText))
}

const norm = (t: string) => cleanText(t).toLowerCase()
const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`

/** Outline with markers -> clean Markdown + refs. A node's own valid markers give slice precision; otherwise it falls back to `fallback(path, text)`. */
function resolveRefs(marked: string, title: string, valid: Set<string>, byId: Map<string, Slice>, fallback: (path: number[], text: string) => NodeRef | undefined) {
  const { tree, marks } = stripMarks(parseMarkdown(marked, title))
  const refs: NodeRef[] = []
  walk(tree, (n, path) => {
    const ids = (marks.get(pathKey(path)) ?? []).filter((id) => valid.has(id))
    const ref = ids.length ? makeRef(path, ids, byId, 'slice') : fallback(path, n.text)
    if (ref) refs.push(ref)
  })
  return { tree, markdown: serializeOutline(tree), refs }
}

export interface TranscriptOpts { sectionSeconds: number; refs: boolean }

export async function generateFromTranscript(ctx: Ctx, slices: Slice[], title: string, opts: TranscriptOpts): Promise<{ markdown: string; refs: NodeRef[] }> {
  const system = ctx.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT
  const groups = planSections(slices, opts.sectionSeconds, ctx.chunkChars, opts.refs)
  if (!groups.length) throw new LlmError('bad_response', 'The transcript is empty.')
  const byId = new Map(slices.map((s) => [s.id, s]))
  const total = groups.length
  const range = (g: Slice[]): [number, number] => [g[0].start, g[g.length - 1].end]
  ctx.emit({ type: 'start', chunks: total, sections: groups.map((g, i) => ({ index: i + 1, sliceIds: [g[0].id, g[g.length - 1].id], timeRange: range(g) })) })
  const streaming = (on: boolean) => { const f = new MarkFilter(); return (t: string) => { const out = f.push(t); if (on && out) ctx.emit({ type: 'delta', text: out }) } }

  const sections: { tree: OutlineNode; refs: NodeRef[]; marked: string }[] = []
  for (let i = 0; i < total; i++) {
    const g = groups[i]
    const okIds = g.filter(hasText).map((s) => s.id)
    const sectionRef = (path: number[]) => makeRef(path, okIds, byId, 'section')
    const [a, b] = range(g)
    if (total > 1) ctx.emit({ type: 'progress', stage: 'section', index: i + 1, total, timeRange: [a, b] })
    const msgs = [{ role: 'system' as const, content: system }, { role: 'user' as const, content: sectionUserPrompt(taggedText(g, opts.refs), i, total, `${fmt(a)}–${fmt(b)}`, opts.refs) }]
    const partTitle = total > 1 ? `Part ${i + 1}` : title
    let marked: string
    try {
      marked = await withRetry(ctx, (s) => streamChat(ctx.cfg, msgs, streaming(s && total === 1), ctx.signal), (r) => validateOutline(r, partTitle, { requireTitle: false, minNodes: total > 1 ? 2 : 3 }), total === 1)
    } catch (e) {
      if (e instanceof LlmError && total > 1) e.index = i + 1
      throw e
    }
    const r = resolveRefs(marked, partTitle, new Set(okIds), byId, sectionRef)
    sections.push({ tree: r.tree, refs: r.refs, marked })
    if (total === 1) {
      ctx.emit({ type: 'done', markdown: r.markdown, refs: r.refs })
      return { markdown: r.markdown, refs: r.refs }
    }
    ctx.emit({ type: 'section_done', index: i + 1, total, markdown: r.markdown, refs: r.refs })
  }

  // Fallback when the merged line lost its markers: a section node with the same text.
  const byText = new Map<string, Set<string>>()
  for (const sec of sections) {
    const at = new Map(sec.refs.map((r) => [pathKey(r.path), r]))
    walk(sec.tree, (n, path) => {
      const ref = at.get(pathKey(path))
      if (!ref || !n.text) return
      const set = byText.get(norm(n.text)) ?? new Set<string>()
      ref.sliceIds.forEach((id) => set.add(id))
      byText.set(norm(n.text), set)
    })
  }
  ctx.emit({ type: 'progress', stage: 'merge' })
  const mergeMsgs = [{ role: 'system' as const, content: system }, { role: 'user' as const, content: transcriptMergePrompt(sections.map((s) => s.marked), opts.refs) }]
  const merged = await withRetry(ctx, (s) => streamChat(ctx.cfg, mergeMsgs, streaming(s), ctx.signal), (r) => validateOutline(r, title, { requireTitle: false, minNodes: 3 }), true)
  const all = new Set(slices.filter(hasText).map((s) => s.id))
  const r = resolveRefs(merged, title, all, byId, (path, text) => {
    const ids = path.length ? byText.get(norm(text)) : undefined
    return ids ? makeRef(path, ids, byId, 'section') : undefined
  })
  ctx.emit({ type: 'done', markdown: r.markdown, refs: r.refs })
  return { markdown: r.markdown, refs: r.refs }
}

/** Appends `incoming` under `parent`, reusing children with the same text. Records new and grown paths; calls `onAdd` for every new node. */
function mergeInto(parent: OutlineNode, incoming: OutlineNode[], at: number[], from: number[], ch: Changes, onAdd: (path: number[], src: number[]) => void): void {
  incoming.forEach((inc, j) => {
    const src = [...from, j]
    const k = inc.text ? parent.children.findIndex((c) => norm(c.text) === norm(inc.text)) : -1
    if (k >= 0) {
      const target = parent.children[k]
      const before = target.children.length
      mergeInto(target, inc.children, [...at, k], src, ch, onAdd)
      if (target.children.length > before) ch.updated.push([...at, k])
      return
    }
    const path = [...at, parent.children.length]
    const node: OutlineNode = { text: inc.text, kind: at.length === 0 ? 'heading' : 'list', children: [] }
    parent.children.push(node)
    ch.added.push(path)
    onAdd(path, src)
    mergeInto(node, inc.children, path, src, { added: [], updated: [] }, onAdd)
  })
}

export interface IncrementalInput { seq: number; title: string; markdown: string; refs: NodeRef[]; newSlices: Slice[]; tags: boolean }

/** Live mode: the LLM only proposes new points per branch; the server appends them to the current tree. Existing nodes never move or disappear. */
export async function incrementalUpdate(ctx: Ctx, input: IncrementalInput): Promise<{ markdown: string; refs: NodeRef[]; changes: Changes }> {
  const { seq } = input
  ctx.emit({ type: 'start', seq, slices: input.newSlices.length })
  const tree: OutlineNode = input.markdown.trim() ? parseMarkdown(input.markdown, input.title) : { text: input.title, kind: 'heading', children: [] }
  const changes: Changes = { added: [], updated: [] }
  const finish = (refs: NodeRef[]) => {
    const res = { markdown: serializeOutline(tree), refs, changes }
    ctx.emit({ type: 'done', seq, ...res })
    return res
  }
  const fresh = input.newSlices.filter(hasText)
  if (!fresh.length) return finish(input.refs)

  const branches = tree.children.map((c) => [`- ${c.text}`, ...c.children.map((g) => `  - ${g.text}`)].join('\n')).join('\n')
  const msgs = [{ role: 'system' as const, content: INCREMENTAL_SYSTEM_PROMPT }, { role: 'user' as const, content: incrementalUserPrompt(tree.text, branches, taggedText(fresh, input.tags), input.tags) }]
  const check = (raw: string): Validation => {
    if (/^\s*NONE\s*$/i.test(stripThink(raw))) return { ok: true, markdown: '' }
    return validateOutline(`# x\n${stripThink(raw).replace(/^\s*#{1,6}\s+/gm, '- ')}`, 'x', { requireTitle: false, minNodes: 2 })
  }
  const md = await withRetry(ctx, () => streamChat(ctx.cfg, msgs, () => {}, ctx.signal), check, false)
  if (!md) return finish(input.refs)

  const { tree: add, marks } = stripMarks(parseMarkdown(md))
  const byId = new Map(fresh.map((s) => [s.id, s]))
  const refs = [...input.refs]
  mergeInto(tree, add.children, [], [], changes, (path, src) => {
    const ids = (marks.get(pathKey(src)) ?? []).filter((id) => byId.has(id))
    const ref = ids.length ? makeRef(path, ids, byId, 'slice') : makeRef(path, byId.keys(), byId, 'section')
    if (ref) refs.push(ref)
  })
  return finish(refs)
}

export { normalizeMarkdown }
