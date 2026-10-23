import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CODE, makeApp, parseSse } from './helpers'
import { planSections } from '../src/server/generate'
import { parseMarkdown } from '../src/shared/outline'
import { MarkFilter, parseSlices, parseTranscriptDoc, stripMarks, takeMarks, type Slice } from '../src/shared/transcript'
// @ts-expect-error plain JS helper
import { MOCK_KEY, MOCK_MODEL, startMockLlm } from '../scripts/mock-llm.mjs'

let mock: { url: string; calls: any[]; close: () => Promise<void> }
beforeAll(async () => { mock = await startMockLlm(0) })
afterAll(async () => { await mock.close() })

async function setup(over = {}) {
  const t = makeApp({ llmBaseUrl: mock.url, llmApiKey: MOCK_KEY, llmModel: MOCK_MODEL, ...over })
  await t.req('POST', '/api/setup', { username: 'admin', password: 'password123', setupCode: CODE })
  return t
}

const LINES = ['今天讨论新产品的发布计划', '目标用户是欧洲的中小企业', '渠道包括线上广告和合作伙伴', '风险是预算和人手都比较紧张', '下个月完成第一版']
/** n slices of `len` seconds each, ids starting at s{from}. */
function slices(n: number, len = 28, from = 1, take = 1, text = (i: number) => `${LINES[i % LINES.length]}，第${i + from}段。`): Slice[] {
  return Array.from({ length: n }, (_, i) => ({ id: `s${i + from}`, start: i * len, end: (i + 1) * len, text: text(i), take, status: 'ok' as const }))
}
const events = async (res: Response) => parseSse(await res.text())

describe('transcript helpers', () => {
  it('parseSlices validates ids, times, order and status', () => {
    expect(parseSlices([{ id: 's1', start: 0, end: 1.23456, text: 'a' }])).toEqual([{ id: 's1', start: 0, end: 1.235, text: 'a', take: 1, status: 'ok' }])
    expect(parseSlices([{ id: 's1', start: 0, end: 1, text: 'lost', status: 'failed' }])).toEqual([{ id: 's1', start: 0, end: 1, text: '', take: 1, status: 'failed' }])
    expect(parseSlices('x')).toMatch(/array/)
    expect(parseSlices([{ id: 'x1', start: 0, end: 1, text: '' }])).toMatch(/id/)
    expect(parseSlices([{ id: 's1', start: 0, end: 1, text: '' }, { id: 's1', start: 1, end: 2, text: '' }])).toMatch(/Duplicate/)
    expect(parseSlices([{ id: 's1', start: 2, end: 1, text: '' }])).toMatch(/start\/end/)
    expect(parseSlices([{ id: 's1', start: 5, end: 6, text: '' }, { id: 's2', start: 1, end: 2, text: '' }])).toMatch(/sorted/)
    // A second take restarts the clock.
    expect(parseSlices([{ id: 's1', start: 5, end: 6, text: '' }, { id: 's2', start: 0, end: 2, text: '', take: 2 }])).toHaveLength(2)
    expect(parseSlices([{ id: 's1', start: 0, end: 1, text: '', status: 'meh' }])).toMatch(/status/)
  })

  it('parseTranscriptDoc checks the version and that refs point to known slices', () => {
    const s = [{ id: 's1', start: 0, end: 1, text: 'a' }]
    const ref = { path: [0], sliceIds: ['s1'], timeRange: [0, 1], take: 1, precision: 'slice' }
    expect(parseTranscriptDoc({ version: 1, slices: s, refs: [ref] })).toMatchObject({ version: 1, refs: [ref] })
    expect(parseTranscriptDoc({ version: 2, slices: s, refs: [] })).toMatch(/version/)
    expect(parseTranscriptDoc({ version: 1, slices: s, refs: [{ ...ref, sliceIds: ['s9'] }] })).toMatch(/unknown slice/)
    expect(parseTranscriptDoc([])).toMatch(/object/)
  })

  it('planSections splits by time, by take and by size, and drops empty sections', () => {
    expect(planSections(slices(50), 600, 12000).map((g) => g.length)).toEqual([21, 21, 8]) // 28 s slices, 10 minutes
    expect(planSections(slices(50), 300, 12000).map((g) => g.length)).toEqual([10, 10, 10, 10, 10])
    const two = [...slices(3), ...slices(2, 28, 4, 2)]
    expect(planSections(two, 600, 12000).map((g) => g.map((s) => s.id))).toEqual([['s1', 's2', 's3'], ['s4', 's5']])
    expect(planSections(slices(10), 600, 60).length).toBeGreaterThan(1)
    const silent = slices(30, 28, 1, 1, (i) => (i >= 21 ? '' : 'x'))
    expect(planSections(silent, 600, 12000)).toHaveLength(1)
  })

  it('takes markers off node text in both bracket styles', () => {
    expect(takeMarks('目标用户 ⟦s1,s2⟧')).toEqual({ text: '目标用户', ids: ['s1', 's2'] })
    expect(takeMarks('风险[s3、s4]')).toEqual({ text: '风险', ids: ['s3', 's4'] })
    expect(takeMarks('数组 [1] 不是标记')).toEqual({ text: '数组 [1] 不是标记', ids: [] })
    const { tree, marks } = stripMarks(parseMarkdown('# 标题\n## 分支 ⟦s1⟧\n- 点 ⟦s2,s3⟧\n'))
    expect(tree.children[0].text).toBe('分支')
    expect(tree.children[0].children[0].text).toBe('点')
    expect([...marks]).toEqual([['0', ['s1']], ['0.0', ['s2', 's3']]])
  })

  it('MarkFilter removes markers split across stream chunks', () => {
    const f = new MarkFilter()
    expect(['- 要点 ⟦s', '1,s2', '⟧\n- 下', '一个'].map((p) => f.push(p)).join('')).toBe('- 要点 \n- 下一个')
  })
})

describe('POST /api/generate mode "transcript"', () => {
  it('one section: streams deltas without markers and returns slice-level refs', async () => {
    const { req } = await setup()
    const res = await req('POST', '/api/generate', { mode: 'transcript', title: '周会', slices: slices(4) })
    expect(res.status).toBe(200)
    const ev = await events(res)
    expect(ev[0].data).toMatchObject({ type: 'start', chunks: 1, sections: [{ index: 1, sliceIds: ['s1', 's4'], timeRange: [0, 112] }] })
    expect(ev.some((e) => e.event === 'section_done')).toBe(false)
    const streamed = ev.filter((e) => e.event === 'delta').map((e) => e.data.text).join('')
    expect(streamed).not.toContain('⟦')
    const done = ev.at(-1)!.data
    expect(done.type).toBe('done')
    expect(done.markdown).not.toContain('⟦')
    const tree = parseMarkdown(done.markdown)
    expect(tree.children).toHaveLength(4)
    expect(done.refs).toContainEqual({ path: [1], sliceIds: ['s2'], timeRange: [28, 56], take: 1, precision: 'slice' })
    expect(done.refs).toContainEqual({ path: [1, 0], sliceIds: ['s2'], timeRange: [28, 56], take: 1, precision: 'slice' })
    // The prompt carried the [sN] tags and the marker rule.
    const user = mock.calls.at(-1).messages[1].content
    expect(user).toContain('[s3] ')
    expect(user).toContain('⟦s12⟧')
  })

  it('several sections: section_done for each, then one merge call; refs survive the merge', async () => {
    const { req } = await setup()
    const before = mock.calls.length
    const ev = await events(await req('POST', '/api/generate', { mode: 'transcript', title: '长会', slices: slices(30, 28), sectionSeconds: 300 }))
    const start = ev[0].data
    expect(start.chunks).toBe(3)
    expect(start.sections.map((s: any) => s.sliceIds)).toEqual([['s1', 's10'], ['s11', 's20'], ['s21', 's30']])
    const progress = ev.filter((e) => e.event === 'progress').map((e) => e.data)
    expect(progress.map((p) => p.stage)).toEqual(['section', 'section', 'section', 'merge'])
    expect(progress[1]).toMatchObject({ index: 2, total: 3, timeRange: [280, 560] })
    const sections = ev.filter((e) => e.event === 'section_done').map((e) => e.data)
    expect(sections.map((s) => s.index)).toEqual([1, 2, 3])
    expect(sections[1].markdown).not.toContain('⟦')
    // Section refs only use the section's own slices.
    expect(sections[1].refs.flatMap((r: any) => r.sliceIds).every((id: string) => Number(id.slice(1)) >= 11 && Number(id.slice(1)) <= 20)).toBe(true)
    expect(mock.calls.length - before).toBe(4)
    const done = ev.at(-1)!.data
    expect(done.markdown).toMatch(/^# Merged outline/)
    expect(done.refs).toContainEqual(expect.objectContaining({ path: [14], sliceIds: ['s15'], precision: 'slice', timeRange: [392, 420] }))
  })

  it('merge without markers falls back to matching section nodes by text', async () => {
    const { req } = await setup()
    const ev = await events(await req('POST', '/api/generate', { mode: 'transcript', slices: slices(20, 28, 1, 1, (i) => `MERGE_DROPS 第${i + 1}段内容。`), sectionSeconds: 300 }))
    const done = ev.at(-1)!.data
    expect(done.type).toBe('done')
    expect(done.markdown).not.toContain('⟦')
    expect(done.refs.length).toBeGreaterThan(0)
    expect(done.refs.every((r: any) => r.precision === 'section')).toBe(true)
    const tree = parseMarkdown(done.markdown)
    const third = done.refs.find((r: any) => r.path.length === 1 && tree.children[r.path[0]].text.includes('第3段'))
    expect(third.sliceIds).toEqual(['s3'])
  })

  it('no markers from the model: section-level refs for every node', async () => {
    const { req } = await setup()
    const ev = await events(await req('POST', '/api/generate', { mode: 'transcript', slices: slices(3, 28, 1, 1, (i) => `NO_MARKS 第${i + 1}段。`) }))
    const done = ev.at(-1)!.data
    expect(done.refs.length).toBe(1 + 3 * 2)
    expect(done.refs.every((r: any) => r.precision === 'section' && r.sliceIds.join() === 's1,s2,s3')).toBe(true)
  })

  it('refs:false sends no tags', async () => {
    const { req } = await setup()
    const ev = await events(await req('POST', '/api/generate', { mode: 'transcript', slices: slices(3), refs: false }))
    expect(ev.at(-1)!.event).toBe('done')
    expect(mock.calls.at(-1).messages[1].content).not.toContain('[s1]')
    expect(ev.at(-1)!.data.refs.every((r: any) => r.precision === 'section')).toBe(true)
  })

  it('failed slices are left out of the text and the refs', async () => {
    const { req } = await setup()
    const s = slices(4)
    s[1] = { ...s[1], status: 'failed' }
    const ev = await events(await req('POST', '/api/generate', { mode: 'transcript', slices: s }))
    const done = ev.at(-1)!.data
    expect(done.type).toBe('done')
    expect(mock.calls.at(-1).messages[1].content).not.toContain('[s2]')
    expect(done.refs.flatMap((r: any) => r.sliceIds)).not.toContain('s2')
    expect(parseMarkdown(done.markdown).children).toHaveLength(3)
  })

  it('a failing section reports its index', async () => {
    const { req } = await setup()
    const ev = await events(await req('POST', '/api/generate', { mode: 'transcript', slices: slices(20, 28, 1, 1, (i) => (i >= 10 ? 'ALWAYS_PROSE' : `第${i}段。`)), sectionSeconds: 300 }))
    expect(ev.filter((e) => e.event === 'section_done')).toHaveLength(1)
    expect(ev.at(-1)!.data).toMatchObject({ type: 'error', code: 'bad_response', index: 2 })
  })

  it('validates the request', async () => {
    const { req } = await setup({ maxInputChars: 100 })
    expect((await req('POST', '/api/generate', { mode: 'transcript' })).status).toBe(400)
    expect((await req('POST', '/api/generate', { mode: 'transcript', slices: [] })).status).toBe(400)
    expect((await req('POST', '/api/generate', { mode: 'transcript', slices: slices(2, 28, 1, 1, () => ' ') })).status).toBe(400)
    expect((await req('POST', '/api/generate', { mode: 'transcript', slices: [{ id: 's1', start: 3, end: 1, text: 'a' }] })).status).toBe(400)
    expect((await req('POST', '/api/generate', { mode: 'transcript', slices: slices(2, 28, 1, 1, () => 'x'.repeat(60)) })).status).toBe(413)
  })
})

describe('POST /api/generate mode "incremental"', () => {
  const MAP = '# 周会\n\n## 发布计划\n- 时间表\n\n## 风险\n- 预算\n'
  const refs = [{ path: [0], sliceIds: ['s1'], timeRange: [0, 8], take: 1, precision: 'slice' }]

  it('appends new points under an existing branch without moving anything', async () => {
    const { req } = await setup()
    const ev = await events(await req('POST', '/api/generate', { mode: 'incremental', docId: 'd1', seq: 7, title: '周会', markdown: MAP, refs, newSlices: slices(2, 8, 5) }))
    expect(ev[0].data).toEqual({ type: 'start', seq: 7, slices: 2 })
    const done = ev.at(-1)!.data
    expect(done).toMatchObject({ type: 'done', seq: 7, changes: { added: [[0, 1], [0, 2]], updated: [[0]] } })
    const tree = parseMarkdown(done.markdown)
    expect(tree.children.map((c) => c.text)).toEqual(['发布计划', '风险'])
    expect(tree.children[0].children.map((c) => c.text)).toEqual(['时间表', '今天讨论新产品的发布计划，第5段。', '目标用户是欧洲的中小企业，第6段。'])
    expect(tree.children[1].children.map((c) => c.text)).toEqual(['预算'])
    expect(done.refs).toEqual([...refs, { path: [0, 1], sliceIds: ['s5'], timeRange: [0, 8], take: 1, precision: 'slice' }, { path: [0, 2], sliceIds: ['s6'], timeRange: [8, 16], take: 1, precision: 'slice' }])
    // The LLM only saw the branches and the new lines.
    const user = mock.calls.at(-1).messages[1].content
    expect(user).toContain('- 发布计划\n  - 时间表')
    expect(user).toContain('[s6] ')
  })

  it('adds a new branch at the end, and builds the map from an empty one', async () => {
    const { req } = await setup()
    let done = (await events(await req('POST', '/api/generate', { mode: 'incremental', seq: 1, title: '周会', markdown: MAP, newSlices: slices(1, 8, 3, 1, () => 'NEW_BRANCH 新话题') }))).at(-1)!.data
    // Only the top of a new subtree is listed.
    expect(done.changes).toEqual({ added: [[2]], updated: [] })
    expect(parseMarkdown(done.markdown).children[2].text).toBe('新分支')
    expect(done.refs[0]).toMatchObject({ path: [2], sliceIds: ['s3'] })
    done = (await events(await req('POST', '/api/generate', { mode: 'incremental', seq: 1, title: '新会', markdown: '', newSlices: slices(1, 8) }))).at(-1)!.data
    expect(parseMarkdown(done.markdown).text).toBe('新会')
    expect(done.changes.added).toEqual([[0]])
    expect(done.refs.map((r: any) => r.path)).toEqual([[0], [0, 0]])
  })

  it('NONE, silence and failed slices leave the map unchanged', async () => {
    const { req } = await setup()
    const before = mock.calls.length
    let done = (await events(await req('POST', '/api/generate', { mode: 'incremental', seq: 2, title: '周会', markdown: MAP, refs, newSlices: [{ id: 's9', start: 0, end: 8, text: '', status: 'failed' }] }))).at(-1)!.data
    expect(mock.calls.length).toBe(before)
    expect(done).toMatchObject({ seq: 2, refs, changes: { added: [], updated: [] } })
    expect(parseMarkdown(done.markdown)).toEqual(parseMarkdown(MAP))
    done = (await events(await req('POST', '/api/generate', { mode: 'incremental', seq: 3, title: '周会', markdown: MAP, newSlices: slices(1, 8, 9, 1, () => 'NOTHING_NEW') }))).at(-1)!.data
    expect(done.changes).toEqual({ added: [], updated: [] })
    expect(parseMarkdown(done.markdown)).toEqual(parseMarkdown(MAP))
  })

  it('returns 409 busy while an update for the same document runs', async () => {
    const { req } = await setup()
    const body = { mode: 'incremental', docId: 'd1', seq: 1, title: '周会', markdown: MAP, newSlices: slices(1, 8, 1, 1, () => 'SLOW 慢慢说') }
    const first = await req('POST', '/api/generate', body)
    const busy = await req('POST', '/api/generate', { ...body, seq: 2 })
    expect(busy.status).toBe(409)
    expect(await busy.json()).toMatchObject({ code: 'busy', seq: 2 })
    // Another document is not blocked.
    const other = await req('POST', '/api/generate', { ...body, docId: 'd2', newSlices: slices(1, 8) })
    expect(other.status).toBe(200)
    await other.text()
    expect((await events(first)).at(-1)!.data).toMatchObject({ type: 'done', seq: 1 })
    // Released afterwards.
    const again = await req('POST', '/api/generate', { ...body, seq: 3, newSlices: slices(1, 8) })
    expect(again.status).toBe(200)
    expect((await events(again)).at(-1)!.data.seq).toBe(3)
  })

  it('validates the request', async () => {
    const { req } = await setup()
    expect((await req('POST', '/api/generate', { mode: 'incremental', markdown: MAP, newSlices: [] })).status).toBe(400)
    expect((await req('POST', '/api/generate', { mode: 'incremental', seq: -1, newSlices: [] })).status).toBe(400)
    expect((await req('POST', '/api/generate', { mode: 'incremental', seq: 1, markdown: 5 })).status).toBe(400)
    expect((await req('POST', '/api/generate', { mode: 'incremental', seq: 1, newSlices: [{ id: 'bad' }] })).status).toBe(400)
    expect((await req('POST', '/api/generate', { mode: 'incremental', seq: 1, refs: [{ path: 'x' }] })).status).toBe(400)
  })
})

describe('documents keep the transcript', () => {
  const transcript = { version: 1, slices: slices(2), refs: [{ path: [0], sliceIds: ['s1', 's2'], timeRange: [0, 56], take: 1, precision: 'section' }] }

  it('saves, returns, keeps and clears it', async () => {
    const { req } = await setup()
    const doc = (await (await req('POST', '/api/docs', { title: 'a', markdown: '# a\n## b\n', transcript })).json()).doc
    expect(doc.transcript).toEqual(transcript)
    expect((await (await req('GET', `/api/docs/${doc.id}`)).json()).doc.transcript).toEqual(transcript)
    // Leaving it out keeps it.
    expect((await (await req('PUT', `/api/docs/${doc.id}`, { markdown: '# a\n## c\n' })).json()).doc.transcript).toEqual(transcript)
    expect((await (await req('GET', `/api/docs/${doc.id}`)).json()).doc).toMatchObject({ markdown: '# a\n## c\n', transcript })
    expect((await (await req('PUT', `/api/docs/${doc.id}`, { transcript: null })).json()).doc.transcript).toBeNull()
    expect((await (await req('GET', `/api/docs/${doc.id}`)).json()).doc.transcript).toBeNull()
  })

  it('documents without one return null; invalid ones are rejected', async () => {
    const { req } = await setup()
    const doc = (await (await req('POST', '/api/docs', { title: 'old' })).json()).doc
    expect(doc.transcript).toBeNull()
    expect((await (await req('GET', `/api/docs/${doc.id}`)).json()).doc.transcript).toBeNull()
    expect((await req('PUT', `/api/docs/${doc.id}`, { transcript: { version: 9 } })).status).toBe(400)
    expect((await req('PUT', `/api/docs/${doc.id}`, { transcript: { ...transcript, refs: [{ ...transcript.refs[0], sliceIds: ['s7'] }] } })).status).toBe(400)
    expect((await req('POST', '/api/docs', { title: 'x', transcript: 'text' })).status).toBe(400)
    expect((await (await req('GET', `/api/docs/${doc.id}`)).json()).doc.transcript).toBeNull()
  })

  it('rejects a transcript over 2 MB', async () => {
    const { req } = await setup()
    const big = { version: 1, slices: slices(30, 28, 1, 1, () => 'a'.repeat(70_000)), refs: [] }
    expect((await req('POST', '/api/docs', { title: 'big', transcript: big })).status).toBe(413)
  })
})
