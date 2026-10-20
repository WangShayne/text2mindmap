import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serve } from '@hono/node-server'
import { CODE, makeApp, parseSse } from './helpers'
import { splitText } from '../src/server/chunk'
import { ThinkFilter } from '../src/server/llm'
import { parseMarkdown, countNodes } from '../src/shared/outline'
// @ts-expect-error plain JS helper
import { MOCK_KEY, MOCK_MODEL, startMockLlm } from '../scripts/mock-llm.mjs'

let mock: { url: string; calls: any[]; close: () => Promise<void> }
beforeAll(async () => { mock = await startMockLlm(0) })
afterAll(async () => { await mock.close() })

const ARTICLE = `人工智能的发展历程。人工智能经历了多次起伏。

早期阶段从1956年达特茅斯会议开始。研究者乐观地认为机器很快就能像人一样思考。符号主义成为主流。

第一次寒冬发生在1970年代。计算能力不足。经费被大幅削减。

深度学习在2012年取得突破。ImageNet比赛中错误率大幅下降。GPU让训练大模型成为可能。

大语言模型带来了新的变化。ChatGPT让普通人也能使用AI。各行各业开始探索应用。`

async function setup(over = {}) {
  const t = makeApp({ llmBaseUrl: mock.url, llmApiKey: MOCK_KEY, llmModel: MOCK_MODEL, ...over })
  await t.req('POST', '/api/setup', { username: 'admin', password: 'password123', setupCode: CODE })
  return t
}

describe('chunking and filters', () => {
  it('splits by paragraph, then sentence, never exceeding the limit', () => {
    const text = Array.from({ length: 50 }, (_, i) => `第${i}段。这是一个句子。还有一个句子！`).join('\n\n') + '\n\n' + '长'.repeat(500)
    const chunks = splitText(text, 200)
    expect(chunks.every((c) => c.length <= 200)).toBe(true)
    expect(chunks.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''))
    expect(splitText('short', 100)).toEqual(['short'])
  })

  it('removes <think> blocks split across stream chunks', () => {
    const f = new ThinkFilter()
    const out = ['# T<thi', 'nk>secret', ' plan</th', 'ink>\n- a', '<', 'b>'].map((s) => f.push(s)).join('') + f.flush()
    expect(out).toBe('# T\n- a<b>')
  })
})

describe('generation via mock OpenAI-compatible SSE server', () => {
  it('streams deltas and returns a normalized outline for Chinese text', async () => {
    const { req } = await setup()
    const res = await req('POST', '/api/generate', { text: ARTICLE, title: 'AI' })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const events = parseSse(await res.text())
    expect(events[0]).toMatchObject({ event: 'start', data: { chunks: 1 } })
    const deltas = events.filter((e) => e.event === 'delta')
    expect(deltas.length).toBeGreaterThan(5)
    expect(deltas.map((d) => d.data.text).join('')).not.toContain('<think>')
    const done = events.find((e) => e.event === 'done')!
    const tree = parseMarkdown(done.data.markdown)
    expect(tree.text).toBe('人工智能的发展历程')
    expect(tree.children.length).toBe(5)
    expect(done.data.markdown).toMatch(/^# 人工智能的发展历程\n\n## /)
    // The admin system prompt was sent upstream
    expect(mock.calls.at(-1).messages[0].content).toContain('mind-map outline')
  })

  it('chunks long input, outlines each part, then merges', async () => {
    const { req } = await setup({ llmChunkChars: 120 })
    const before = mock.calls.length
    const events = parseSse(await (await req('POST', '/api/generate', { text: ARTICLE })).text())
    const start = events.find((e) => e.event === 'start')!
    expect(start.data.chunks).toBeGreaterThan(1)
    expect(events.filter((e) => e.event === 'progress' && e.data.stage === 'chunk')).toHaveLength(start.data.chunks)
    expect(events.some((e) => e.event === 'progress' && e.data.stage === 'merge')).toBe(true)
    expect(mock.calls.length - before).toBe(start.data.chunks + 1)
    const md = events.find((e) => e.event === 'done')!.data.markdown
    expect(md.startsWith('# Merged outline\n')).toBe(true)
    expect(md).not.toContain('```')
  })

  it('retries once on invalid output, then succeeds', async () => {
    const { req } = await setup()
    const events = parseSse(await (await req('POST', '/api/generate', { text: 'PROSE_ONCE\n\nFirst point. Second point.\n\nThird.' })).text())
    expect(events.some((e) => e.event === 'retry')).toBe(true)
    expect(events.at(-1)!.event).toBe('done')
  })

  it('reports a clear error after the retry fails', async () => {
    const { req } = await setup()
    const events = parseSse(await (await req('POST', '/api/generate', { text: 'ALWAYS_PROSE please' })).text())
    expect(events.filter((e) => e.event === 'retry')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ event: 'error', data: { code: 'bad_response' } })
    expect(events.at(-1)!.data.message).toMatch(/not a valid outline/)
  })

  it('reports auth and config errors as SSE error events', async () => {
    const { req } = await setup({ llmApiKey: 'sk-nope' })
    const events = parseSse(await (await req('POST', '/api/generate', { text: 'hello. world.' })).text())
    expect(events.at(-1)).toMatchObject({ event: 'error', data: { code: 'auth' } })
    expect(JSON.stringify(events)).not.toContain('sk-nope')
  })

  it('expands a selected node into child bullets', async () => {
    const { req } = await setup()
    const events = parseSse(await (await req('POST', '/api/generate', { mode: 'expand', path: ['根', '分支'], existing: ['已有'], markdown: '# 根\n## 分支\n- 已有\n' })).text())
    const done = events.find((e) => e.event === 'done')!
    expect(done.data.markdown).toBe('- 新子节点一\n  - 细节 A\n- 新子节点二\n- New child three\n')
    expect(mock.calls.at(-1).messages[1].content).toContain('根 > 分支')
  })

  it('stopping the request aborts the upstream call', async () => {
    const { app } = await setup()
    const { getCookie } = await (async () => ({ getCookie: () => '' }))()
    void getCookie
    // Use a real HTTP server so the client disconnect propagates.
    const t = await setup()
    const server = serve({ fetch: t.app.fetch, port: 0, hostname: '127.0.0.1' })
    await new Promise((r) => server.once('listening', r))
    const port = (server.address() as { port: number }).port
    const ac = new AbortController()
    const res = await fetch(`http://127.0.0.1:${port}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: t.getCookie() },
      body: JSON.stringify({ text: 'SLOW ' + ARTICLE }),
      signal: ac.signal,
    })
    const reader = res.body!.getReader()
    await reader.read()
    await reader.read()
    const before = mock.calls.filter((c) => c.aborted).length
    ac.abort()
    await new Promise((r) => setTimeout(r, 800))
    expect(mock.calls.filter((c) => c.aborted).length).toBeGreaterThan(before)
    server.close()
    void app
  })

  it('3000-character Chinese article produces a usable map', async () => {
    const { req } = await setup()
    const long = Array.from({ length: 30 }, (_, i) => `第${i + 1}部分讲的是一个主题。这里有一些细节说明。还有补充的内容和例子。最后是小结。`).join('\n\n')
    const text = (long + '\n\n').repeat(Math.ceil(3000 / long.length)).slice(0, 3200)
    const events = parseSse(await (await req('POST', '/api/generate', { text })).text())
    const md = events.find((e) => e.event === 'done')!.data.markdown
    expect(countNodes(parseMarkdown(md))).toBeGreaterThan(10)
  })
})
