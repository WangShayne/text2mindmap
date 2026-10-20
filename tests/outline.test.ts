import { describe, expect, it } from 'vitest'
import { canonicalize, normalizeMarkdown, parseMarkdown, serializeOutline, type OutlineNode } from '../src/shared/outline'
import { outlineToSmm, smmToOutline } from '../src/shared/smm'

const h = (text: string, ...children: OutlineNode[]): OutlineNode => ({ text, kind: 'heading', children })
const l = (text: string, ...children: OutlineNode[]): OutlineNode => ({ text, kind: 'list', children })

function roundTrip(md: string) {
  const once = normalizeMarkdown(md)
  expect(normalizeMarkdown(once)).toBe(once) // idempotent
  expect(parseMarkdown(once)).toEqual(parseMarkdown(md))
  return once
}

describe('parseMarkdown', () => {
  it('maps headings and nested lists to a tree', () => {
    const md = '# Root\n\n## A\n\n- a1\n  - a1x\n- a2\n\n## B\n### B1\n- b1i\n'
    expect(parseMarkdown(md)).toEqual(h('Root', h('A', l('a1', l('a1x')), l('a2')), h('B', h('B1', l('b1i')))))
  })

  it('handles Chinese text, full-width punctuation and mixed markers', () => {
    const md = '# 机器学习入门\n## 监督学习\n* 分类：判断类别\n  + 逻辑回归\n1. 回归（预测数值）\n## 无监督学习\n- 聚类\n'
    expect(parseMarkdown(md)).toEqual(h('机器学习入门', h('监督学习', l('分类：判断类别', l('逻辑回归')), l('回归（预测数值）')), h('无监督学习', l('聚类'))))
    roundTrip(md)
  })

  it('tolerates skipped heading levels and inconsistent indentation', () => {
    const md = '# R\n### deep\n- a\n   - b\n - c\n\t- d\n'
    // " - c" (indent 1) is deeper than "- a" (0) but shallower than "   - b" (3), so it is a child of a.
    expect(parseMarkdown(md)).toEqual(h('R', h('deep', l('a', l('b'), l('c', l('d'))))))
  })

  it('strips code fences, think blocks, blockquotes, rules and prose noise', () => {
    const md = '<think>\nreasoning here\n</think>\n```markdown\n# T\n> - quoted\n---\n- x\n```\n'
    expect(parseMarkdown(md)).toEqual(h('T', l('quoted'), l('x')))
  })

  it('joins indented continuation lines and keeps paragraphs as nodes', () => {
    const md = '# T\nIntro line\n- item\n  continued here\n'
    expect(parseMarkdown(md)).toEqual(h('T', l('Intro line'), l('item continued here')))
  })

  it('wraps multiple top-level nodes with the fallback title', () => {
    expect(parseMarkdown('- a\n- b', '标题')).toEqual(h('标题', l('a'), l('b')))
    expect(parseMarkdown('', 'Empty')).toEqual(h('Empty'))
    expect(parseMarkdown('# One\n# Two', 'Doc')).toEqual(h('Doc', h('One'), h('Two')))
  })

  it('a single top-level list item becomes the root', () => {
    expect(parseMarkdown('- root\n  - child')).toEqual(h('root', l('child')))
  })

  it('removes task boxes and closing hashes', () => {
    expect(parseMarkdown('# T ##\n- [x] done\n- [ ] todo')).toEqual(h('T', l('done'), l('todo')))
  })
})

describe('serializeOutline', () => {
  it('writes canonical Markdown', () => {
    const md = serializeOutline(h('Root', h('A', l('a1', l('a1x'))), l('loose')))
    // "loose" follows a heading sibling, so it is promoted to a heading to keep its parent.
    expect(md).toBe('# Root\n\n## A\n\n- a1\n  - a1x\n\n## loose\n')
    expect(parseMarkdown(md)).toEqual(h('Root', h('A', l('a1', l('a1x'))), h('loose')))
  })

  it('keeps bullets before headings as bullets', () => {
    const t = h('R', l('note'), h('Sec', l('x')))
    expect(serializeOutline(t)).toBe('# R\n\n- note\n\n## Sec\n\n- x\n')
    expect(canonicalize(t)).toEqual(t)
  })

  it('switches to bullets below heading level 6 (deep nesting)', () => {
    let node = l('leaf')
    let t: OutlineNode = node
    for (let i = 9; i >= 1; i--) t = h(`H${i}`, t)
    const md = serializeOutline(t)
    expect(md).toContain('###### H6')
    expect(md).toContain('- H7\n  - H8\n    - H9\n      - leaf')
    const back = parseMarkdown(md)
    // structure (texts and depth) survives even though kinds below level 6 become bullets
    const texts = (n: OutlineNode): string[] => [n.text, ...n.children.flatMap(texts)]
    expect(texts(back)).toEqual(texts(t))
    expect(normalizeMarkdown(md)).toBe(md)
    void node
  })

  it('round-trips 200-level-deep bullet nesting', () => {
    let md = '# deep\n'
    for (let i = 0; i < 200; i++) md += `${'  '.repeat(i)}- n${i}\n`
    const out = roundTrip(md)
    expect(out.trim().split('\n').length).toBe(202)
  })

  it('flattens newlines in node text and keeps empty nodes', () => {
    const t = h('R', l('line1\nline2'), l(''), l('x'))
    const md = serializeOutline(t)
    expect(md).toBe('# R\n\n- line1 line2\n-\n- x\n')
    expect(parseMarkdown(md)).toEqual(h('R', l('line1 line2'), l(''), l('x')))
  })

  it('keeps markdown-looking text inside nodes', () => {
    const t = h('R', l('# not a heading'), l('1. not a number'), h('- not a bullet'))
    expect(canonicalize(t)).toEqual(t)
  })

  it('round-trips random trees', () => {
    let seed = 42
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    const words = ['alpha', '中文节点', 'β', 'with **bold**', 'a [link](http://x.y)', '数字 123', 'emoji 🎉']
    const gen = (depth: number, parentKind: 'heading' | 'list'): OutlineNode => {
      const kind = parentKind === 'list' ? 'list' : rnd() < 0.5 ? 'heading' : 'list'
      const n = depth > 7 ? 0 : Math.floor(rnd() * 4)
      return { text: words[Math.floor(rnd() * words.length)], kind, children: Array.from({ length: n }, () => gen(depth + 1, kind)) }
    }
    for (let i = 0; i < 200; i++) {
      const t = { ...gen(0, 'heading'), kind: 'heading' as const }
      const c = canonicalize(t)
      expect(canonicalize(c)).toEqual(c)
      expect(serializeOutline(c)).toBe(serializeOutline(t))
    }
  })
})

describe('mind map adapter data', () => {
  it('outline -> smm -> outline is lossless', () => {
    const t = h('根', h('A', l('a1', l('a1x'))), l('b'))
    expect(smmToOutline(outlineToSmm(t))).toEqual(t)
  })

  it('infers kinds for nodes created on the map', () => {
    const smm = outlineToSmm(h('R', h('A', l('a1'))))
    smm.children!.push({ data: { text: 'new sibling of A' } })
    smm.children![0].children!.push({ data: { text: 'new under A' } })
    smm.children![0].children![0].children = [{ data: { text: 'new under a1' } }]
    const back = smmToOutline(smm)
    expect(back).toEqual(h('R', h('A', l('a1', l('new under a1')), l('new under A')), h('new sibling of A')))
  })

  it('cleans HTML that rich text may leave in node text', () => {
    expect(smmToOutline({ data: { text: 'a<br>b &amp; <b>c</b>' } }).text).toBe('a b & c')
  })
})
