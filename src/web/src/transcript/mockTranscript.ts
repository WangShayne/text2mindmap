/**
 * Mock recording for v0.5 front-end work without a microphone or ASR: open the app with
 * `?mock=transcript` and press 🧪 in the toolbar. Slices arrive every `?every=` ms (default 2000)
 * and go through the same incremental endpoint as a real recording, so run the server against
 * scripts/mock-llm.mjs. In the mock LLM, `NEW_BRANCH` in a request adds a new top-level branch;
 * otherwise new points go under the first branch.
 */
import type { LiveSlice } from './useLiveMap'

export const MOCK_LINES = [
  '今天我们讨论一下新产品的发布计划。',
  '目标用户主要是欧洲的中小企业。',
  '他们最关心价格和数据合规。',
  '', // ASR failure: retry turns it into the next line
  '渠道包括线上广告和合作伙伴（NEW_BRANCH）。',
  '合作伙伴优先找本地的系统集成商。',
  '风险方面，预算和人手都比较紧张（NEW_BRANCH）。',
  '最后确认时间表，下个月完成第一版。',
]
const RETRY_TEXT = '定价先参考竞品，年付打八折。'
const SLICE_SECONDS = 8

export const isMockTranscript = () => new URLSearchParams(location.search).get('mock') === 'transcript'
export const mockEveryMs = () => Number(new URLSearchParams(location.search).get('every')) || 2000

/** Feeds MOCK_LINES as slices: `transcribing` first, then committed (`ok` or `failed`). Returns stop(). */
export function startMockFeed(upsert: (s: LiveSlice) => void, onEnd: () => void, everyMs = mockEveryMs()): () => void {
  let i = 0
  const timers: number[] = []
  const tick = () => {
    if (i >= MOCK_LINES.length) { onEnd(); return }
    const n = i++
    const base = { id: `s${n + 1}`, start: n * SLICE_SECONDS, end: (n + 1) * SLICE_SECONDS, take: 1 }
    upsert({ ...base, text: '', status: 'ok', client: 'transcribing' })
    timers.push(window.setTimeout(() => {
      const text = MOCK_LINES[n]
      upsert({ ...base, text, status: text ? 'ok' : 'failed' })
    }, Math.min(400, everyMs / 2)))
    timers.push(window.setTimeout(tick, everyMs))
  }
  tick()
  return () => timers.forEach((t) => clearTimeout(t))
}

/** Retries a failed mock slice: `retrying`, then `ok` with fixed text. */
export function mockRetry(s: LiveSlice, upsert: (s: LiveSlice) => void) {
  upsert({ ...s, client: 'retrying' })
  window.setTimeout(() => upsert({ ...s, client: undefined, status: 'ok', text: RETRY_TEXT }), 800)
}
