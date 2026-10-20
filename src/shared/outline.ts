/**
 * Markdown <-> outline tree conversion.
 *
 * Markdown is the single source of truth of a document. The mind map is always
 * derived from it, and edits on the map are serialized back to Markdown.
 *
 * Mapping (see README "Markdown mapping"):
 *  - The document has exactly one root node, written as a level-1 heading `# Title`.
 *  - Headings `##`..`######` nest by level: a heading is a child of the nearest
 *    preceding heading with a lower level (skipped levels are tolerated).
 *  - List items (`-`, `*`, `+`, `1.`, `1)`) are children of the heading above them,
 *    nested by indentation (tabs count as 4 spaces; any deeper indent = child).
 *  - A plain paragraph line becomes a list-style child of the current heading, or is
 *    appended to the previous list item when it is indented as a continuation.
 *  - Code-fence lines (```), blockquote markers (>), horizontal rules and blank lines
 *    are ignored. `<think>...</think>` blocks (reasoning models) are removed.
 *  - If the text has no single top-level node, a root titled with `fallbackTitle`
 *    is created to hold the top-level nodes.
 *
 * Serialization (tree -> Markdown) is canonical: root = `# `, heading nodes whose
 * ancestors are all headings become `##`..`######` by depth, everything else is a
 * `- ` bullet indented by two spaces per level. Each node remembers whether it was a
 * heading or a list item (`kind`) so round trips keep the author's structure.
 */

export type NodeKind = 'heading' | 'list'

export interface OutlineNode {
  text: string
  kind: NodeKind
  children: OutlineNode[]
}

const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/
const LIST_RE = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const FENCE_RE = /^[ \t]*(```|~~~)/
const TASK_RE = /^\[[ xX]\][ \t]+/

function indentWidth(ws: string): number {
  let w = 0
  for (const ch of ws) w += ch === '\t' ? 4 - (w % 4) : 1
  return w
}

export function cleanText(s: string): string {
  return s
    .replace(/\r?\n/g, ' ')
    .replace(/[ \t]+#+[ \t]*$/, '') // closing ATX hashes
    .replace(/\s+/g, ' ')
    .trim()
}

export function stripThink(md: string): string {
  return md.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '')
}

export function parseMarkdown(md: string, fallbackTitle = 'Untitled'): OutlineNode {
  const virtual: OutlineNode = { text: '', kind: 'heading', children: [] }
  const headingStack: { level: number; node: OutlineNode }[] = [{ level: 0, node: virtual }]
  let listStack: { indent: number; node: OutlineNode }[] = []
  let lastListIndent = -1

  const lines = stripThink(md).replace(/\r\n?/g, '\n').split('\n')
  for (let raw of lines) {
    if (FENCE_RE.test(raw)) continue
    raw = raw.replace(/^([ \t]*>)+[ \t]?/, '') // blockquote markers
    if (raw.trim() === '') continue
    if (HR_RE.test(raw)) continue

    const h = HEADING_RE.exec(raw)
    if (h) {
      const level = h[1].length
      const node: OutlineNode = { text: cleanText(h[2] ?? ''), kind: 'heading', children: [] }
      while (headingStack.length > 1 && headingStack[headingStack.length - 1].level >= level) headingStack.pop()
      headingStack[headingStack.length - 1].node.children.push(node)
      headingStack.push({ level, node })
      listStack = []
      lastListIndent = -1
      continue
    }

    const l = LIST_RE.exec(raw)
    if (l) {
      const indent = indentWidth(l[1])
      const text = cleanText((l[2] ?? '').replace(TASK_RE, ''))
      const node: OutlineNode = { text, kind: 'list', children: [] }
      while (listStack.length && listStack[listStack.length - 1].indent >= indent) listStack.pop()
      const parent = listStack.length ? listStack[listStack.length - 1].node : headingStack[headingStack.length - 1].node
      parent.children.push(node)
      listStack.push({ indent, node })
      lastListIndent = indent
      continue
    }

    // Plain text line
    const m = /^([ \t]*)(.*)$/.exec(raw)!
    const indent = indentWidth(m[1])
    const text = cleanText(m[2])
    if (listStack.length && indent > lastListIndent) {
      const last = listStack[listStack.length - 1].node
      last.text = last.text ? `${last.text} ${text}` : text
      continue
    }
    const node: OutlineNode = { text, kind: 'list', children: [] }
    headingStack[headingStack.length - 1].node.children.push(node)
    listStack = []
    lastListIndent = -1
  }

  if (virtual.children.length === 1) {
    const root = virtual.children[0]
    return { ...root, kind: 'heading' }
  }
  return { text: cleanText(fallbackTitle) || 'Untitled', kind: 'heading', children: virtual.children }
}

export function serializeOutline(root: OutlineNode): string {
  const out: string[] = []
  const pushHeading = (level: number, text: string) => {
    if (out.length) out.push('')
    out.push(`${'#'.repeat(level)} ${cleanText(text)}`.trimEnd())
  }
  const emitList = (node: OutlineNode, listDepth: number) => {
    out.push(`${'  '.repeat(listDepth)}- ${cleanText(node.text)}`.trimEnd())
    for (const c of node.children) emitList(c, listDepth + 1)
  }
  const emitChildren = (parent: OutlineNode, depth: number) => {
    // depth = depth of the children (root children = 1). Heading level = depth + 1.
    const headingOk = depth + 1 <= 6
    let seenHeading = false
    let listOpen = false
    for (const c of parent.children) {
      // A bullet after a sub-heading would be read back as a child of that
      // sub-heading, so it is promoted to a heading to keep the structure.
      const asHeading = headingOk && (c.kind === 'heading' || seenHeading)
      if (asHeading) {
        seenHeading = true
        listOpen = false
        pushHeading(depth + 1, c.text)
        emitChildren(c, depth + 1)
      } else {
        if (!listOpen && out.length) out.push('')
        listOpen = true
        emitList(c, 0)
      }
    }
  }
  pushHeading(1, root.text)
  emitChildren(root, 1)
  return out.join('\n') + '\n'
}

/** Clean up LLM output: drop fences/think blocks/prose noise, fix indentation. */
export function normalizeMarkdown(md: string, fallbackTitle = 'Untitled'): string {
  return serializeOutline(parseMarkdown(md, fallbackTitle))
}

/** Return the tree with list/heading kinds as they would be read back after serialization. */
export function canonicalize(root: OutlineNode): OutlineNode {
  return parseMarkdown(serializeOutline(root))
}

export function countNodes(root: OutlineNode): number {
  return 1 + root.children.reduce((n, c) => n + countNodes(c), 0)
}

export function maxDepth(root: OutlineNode): number {
  return 1 + root.children.reduce((d, c) => Math.max(d, maxDepth(c)), 0)
}
