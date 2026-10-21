// Pure helpers for bench.mjs (unit-tested in tests/asr-bench.test.ts).

// Same cleanup as src/server/asr.ts
// Keep in sync with cleanTranscript in src/server/asr.ts (SenseVoice <|..|> tags, Qwen3-ASR "language X<asr_text>" prefix).
export const cleanTranscript = (s) => s
  .replace(/<\|[^|<>]{0,40}\|>/g, '')
  .replace(/language[ \t]+[A-Za-z][A-Za-z _-]{0,30}?[ \t]*<asr_text>/g, '')
  .replace(/<\/?asr_text>/g, '')
  .replace(/[ \t]+\n/g, '\n')
  .trim()

/** Character error rate on normalized text: punctuation and spaces removed, lower case, full-width folded. */
export function normalizeForCer(s) {
  return s.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '')
}
export function cer(ref, hyp) {
  const r = [...normalizeForCer(ref)], h = [...normalizeForCer(hyp)]
  // Levenshtein with backtrace counts (S, D, I)
  const n = r.length, m = h.length
  let prev = Array.from({ length: m + 1 }, (_, j) => ({ c: j, s: 0, d: 0, i: j }))
  for (let i = 1; i <= n; i++) {
    const cur = [{ c: i, s: 0, d: i, i: 0 }]
    for (let j = 1; j <= m; j++) {
      const sub = prev[j - 1], del = prev[j], ins = cur[j - 1]
      const same = r[i - 1] === h[j - 1]
      const cs = sub.c + (same ? 0 : 1), cd = del.c + 1, ci = ins.c + 1
      if (cs <= cd && cs <= ci) cur.push({ c: cs, s: sub.s + (same ? 0 : 1), d: sub.d, i: sub.i })
      else if (cd <= ci) cur.push({ c: cd, s: del.s, d: del.d + 1, i: del.i })
      else cur.push({ c: ci, s: ins.s, d: ins.d, i: ins.i + 1 })
    }
    prev = cur
  }
  const e = prev[m]
  return { cer: n ? e.c / n : 0, errors: e.c, sub: e.s, del: e.d, ins: e.i, refChars: n, hypChars: m }
}

