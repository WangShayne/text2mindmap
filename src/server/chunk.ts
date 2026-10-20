/** Split long text into chunks of at most `max` chars, preferring paragraph, then sentence boundaries. */
export function splitText(text: string, max: number): string[] {
  const t = text.replace(/\r\n?/g, '\n').trim()
  if (t.length <= max) return t ? [t] : []
  const pieces: string[] = []
  for (const para of t.split(/\n\s*\n/)) {
    const p = para.trim()
    if (!p) continue
    if (p.length <= max) { pieces.push(p); continue }
    // sentence split (Chinese and Western punctuation), keep the delimiter
    const sentences = p.match(/[^。！？!?.;；\n]+[。！？!?.;；\n]*/g) ?? [p]
    let buf = ''
    for (const s of sentences) {
      if (s.length > max) {
        if (buf) { pieces.push(buf); buf = '' }
        for (let i = 0; i < s.length; i += max) pieces.push(s.slice(i, i + max))
        continue
      }
      if (buf.length + s.length > max) { pieces.push(buf); buf = '' }
      buf += s
    }
    if (buf) pieces.push(buf)
  }
  const chunks: string[] = []
  let cur = ''
  for (const p of pieces) {
    if (cur && cur.length + 2 + p.length > max) { chunks.push(cur); cur = '' }
    cur = cur ? `${cur}\n\n${p}` : p
  }
  if (cur) chunks.push(cur)
  return chunks
}
