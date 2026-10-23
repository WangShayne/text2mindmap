import { describe, expect, it, vi, beforeEach } from 'vitest'

// A tiny hook runner standing in for React: state lives in slots by call order and every setState re-renders.
const hooks = vi.hoisted(() => {
  const h = { slots: [] as unknown[], i: 0, render: () => {} }
  return h
})
vi.mock('react', () => ({
  useState: <T>(init: T) => {
    const i = hooks.i++
    if (!(i in hooks.slots)) hooks.slots[i] = init
    return [hooks.slots[i] as T, (u: T | ((p: T) => T)) => { hooks.slots[i] = typeof u === 'function' ? (u as (p: T) => T)(hooks.slots[i] as T) : u; hooks.render() }]
  },
  useRef: <T>(init: T) => { const i = hooks.i++; if (!(i in hooks.slots)) hooks.slots[i] = { current: init }; return hooks.slots[i] },
  useCallback: <T>(fn: T) => fn,
}))

const streamGenerate = vi.fn()
vi.mock('../src/web/src/api', async () => {
  class ApiError extends Error { constructor(public status: number, message: string) { super(message) } }
  return { ApiError, streamGenerate: (...a: unknown[]) => streamGenerate(...a) }
})

const { useLiveMap } = await import('../src/web/src/transcript/useLiveMap')
const { ApiError } = await import('../src/web/src/api')

const slice = (id: string) => ({ id, start: 0, end: 1, text: id, take: 1, status: 'ok' as const })
const done = (seq: number, markdown: string) => ({ type: 'done', seq, markdown, refs: [], changes: { added: [], updated: [] } })

function setup() {
  const onApply = vi.fn()
  const onBusy = vi.fn()
  let current!: ReturnType<typeof useLiveMap>
  hooks.slots = []
  hooks.render = () => { hooks.i = 0; current = useLiveMap({ docId: 'd', title: () => 't', getMarkdown: () => '# t', onApply, onBusy }) }
  hooks.render()
  return { lm: { upsert: (...a: Parameters<typeof current.upsert>) => current.upsert(...a), send: (m?: boolean) => current.send(m), unsentCount: () => current.unsentCount() }, onApply, onBusy }
}

beforeEach(() => streamGenerate.mockReset())

describe('useLiveMap', () => {
  it('drops a done event whose seq is older than the last applied one', async () => {
    const { lm, onApply } = setup()
    lm.upsert(slice('s1'))
    streamGenerate.mockImplementationOnce(async (_b, on) => { on(done(5, 'new')); on(done(3, 'stale')) })
    await lm.send()
    expect(onApply).toHaveBeenCalledTimes(1)
    expect(onApply.mock.calls[0][0]).toBe('new')
    expect(lm.unsentCount()).toBe(0)
  })

  it('keeps slices after a silent 409 and sends them with the next round', async () => {
    const { lm, onApply, onBusy } = setup()
    lm.upsert(slice('s1'))
    streamGenerate.mockRejectedValueOnce(new ApiError(409, 'busy'))
    await lm.send()
    expect(onBusy).not.toHaveBeenCalled()
    expect(lm.unsentCount()).toBe(1)

    lm.upsert(slice('s2'))
    streamGenerate.mockImplementationOnce(async (body, on) => on(done(body.seq, 'merged')))
    await lm.send()
    const body = streamGenerate.mock.calls[1][0]
    expect(body.mode).toBe('incremental')
    expect(body.newSlices.map((s: { id: string }) => s.id)).toEqual(['s1', 's2'])
    expect(body.seq).toBe(2)
    expect(onApply).toHaveBeenCalledOnce()
    expect(lm.unsentCount()).toBe(0)
  })

  it('reports a manual 409 to the user', async () => {
    const { lm, onBusy } = setup()
    lm.upsert(slice('s1'))
    streamGenerate.mockRejectedValueOnce(new ApiError(409, 'busy'))
    await lm.send(true)
    expect(onBusy).toHaveBeenCalledOnce()
    expect(lm.unsentCount()).toBe(1)
  })

  it('does not send slices that are still in a front-end state', async () => {
    const { lm } = setup()
    lm.upsert({ ...slice('s1'), client: 'transcribing' })
    await lm.send()
    expect(streamGenerate).not.toHaveBeenCalled()
  })
})
