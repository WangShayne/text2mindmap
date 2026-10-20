import { countNodes, normalizeMarkdown, parseMarkdown, serializeOutline, stripThink } from '../shared/outline'
import { splitText } from './chunk'
import { DEFAULT_SYSTEM_PROMPT, EXPAND_SYSTEM_PROMPT, chunkUserPrompt, expandUserPrompt, mergeUserPrompt } from './prompts'
import { LlmError, streamChat, type LlmConfig } from './llm'

export type GenEvent =
  | { type: 'start'; chunks: number }
  | { type: 'progress'; stage: 'chunk' | 'merge'; index?: number; total?: number }
  | { type: 'delta'; text: string }
  | { type: 'retry'; reason: string }
  | { type: 'done'; markdown: string }
  | { type: 'error'; code: string; message: string }

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

export { normalizeMarkdown }
