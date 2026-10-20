/**
 * Outline tree <-> simple-mind-map node data.
 * Each map node stores the Markdown kind in `data.mdKind` so a round trip keeps
 * headings as headings and bullets as bullets. Nodes created on the map have no
 * kind yet; it is inferred from their neighbours (see inferKind).
 */
import type { NodeKind, OutlineNode } from './outline'

export interface SmmNode {
  data: { text: string; uid?: string; mdKind?: NodeKind; expand?: boolean; [k: string]: unknown }
  children?: SmmNode[]
}

export function outlineToSmm(node: OutlineNode, path = 'n'): SmmNode {
  return {
    data: { text: node.text, mdKind: node.kind, uid: path },
    children: node.children.map((c, i) => outlineToSmm(c, `${path}-${i}`)),
  }
}

function nodeText(n: SmmNode): string {
  const t = n.data?.text ?? ''
  // Plain-text mode can still contain <br> or HTML entities if rich text was pasted.
  return String(t)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function inferKind(parentKind: NodeKind, siblings: SmmNode[], index: number, depth: number): NodeKind {
  if (parentKind === 'list') return 'list'
  for (let i = index - 1; i >= 0; i--) {
    const k = siblings[i].data?.mdKind
    if (k) return k
  }
  for (let i = index + 1; i < siblings.length; i++) {
    const k = siblings[i].data?.mdKind
    if (k) return k
  }
  return depth <= 2 ? 'heading' : 'list'
}

export function smmToOutline(node: SmmNode, depth = 0, parentKind: NodeKind = 'heading'): OutlineNode {
  const kind: NodeKind = depth === 0 ? 'heading' : (node.data?.mdKind ?? parentKind)
  const children = node.children ?? []
  return {
    text: nodeText(node),
    kind,
    children: children.map((c, i) => {
      const k = c.data?.mdKind ?? inferKind(kind, children, i, depth + 1)
      return smmToOutline({ ...c, data: { ...c.data, mdKind: k } }, depth + 1, kind)
    }),
  }
}
