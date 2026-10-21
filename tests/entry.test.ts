import { describe, expect, it } from 'vitest'
import { appendOutlineUnder, classifyFile, isTrivialMarkdown, titleFromFileName, UPLOAD_ACCEPT } from '../src/web/src/lib/entry'
import { parseMarkdown } from '../src/shared/outline'
import { appendPiece } from '../src/web/src/audio/useTranscriber'

describe('classifyFile (upload button + drag-and-drop routing)', () => {
  it('routes audio to speech recognition', () => {
    for (const n of ['a.mp3', 'B.M4A', 'c.wav', 'd.webm', 'e.ogg', 'f.opus', 'g.flac', 'h.aac', 'i.mp4']) expect(classifyFile(n)).toBe('audio')
    expect(classifyFile('voice', 'audio/x-m4a')).toBe('audio')
    expect(classifyFile('clip', 'video/webm')).toBe('audio')
  })
  it('imports Markdown directly and sends plain text to generation', () => {
    expect(classifyFile('notes.md')).toBe('markdown')
    expect(classifyFile('notes.MARKDOWN', '')).toBe('markdown')
    expect(classifyFile('x', 'text/markdown')).toBe('markdown')
    expect(classifyFile('meeting.txt')).toBe('text')
    expect(classifyFile('subs.srt')).toBe('text')
    expect(classifyFile('x', 'text/plain')).toBe('text')
  })
  it('lets the extension win over a misleading MIME type', () => {
    expect(classifyFile('notes.md', 'text/plain')).toBe('markdown')
    expect(classifyFile('talk.webm', 'video/webm')).toBe('audio')
    expect(classifyFile('readme.txt', 'application/octet-stream')).toBe('text')
  })
  it('rejects everything else', () => {
    expect(classifyFile('photo.png', 'image/png')).toBe('unsupported')
    expect(classifyFile('doc.pdf', 'application/pdf')).toBe('unsupported')
    expect(classifyFile('noext')).toBe('unsupported')
  })
  it('accept list covers all three routes', () => {
    for (const x of ['audio/*', '.md', '.txt', '.m4a']) expect(UPLOAD_ACCEPT.split(',')).toContain(x)
  })
})

describe('isTrivialMarkdown (empty-state cards)', () => {
  it('treats blank and title-only documents as empty', () => {
    expect(isTrivialMarkdown('')).toBe(true)
    expect(isTrivialMarkdown('  \n')).toBe(true)
    expect(isTrivialMarkdown('# 未命名\n')).toBe(true)
    expect(isTrivialMarkdown('#')).toBe(true)
  })
  it('anything with content is not empty', () => {
    expect(isTrivialMarkdown('# T\n- a')).toBe(false)
    expect(isTrivialMarkdown('hello')).toBe(false)
  })
})

describe('appendOutlineUnder (append-to-selected-node placement)', () => {
  const doc = '# Root\n\n## A\n- a1\n\n## B\n'
  it('attaches the generated root and its subtree under the selected node', () => {
    const out = appendOutlineUnder(doc, [1], '# Talk\n\n## Point 1\n- detail\n## Point 2\n', 'Untitled')
    expect(out).toBe('# Root\n\n## A\n\n- a1\n\n## B\n\n- Talk\n  - Point 1\n    - detail\n  - Point 2\n')
  })
  it('appends under the root when the root is selected', () => {
    const out = appendOutlineUnder(doc, [], '# New\n- x', 'Untitled')
    // A root-level item after "## B" must stay a heading, or it would re-parse as B's child.
    expect(out).toBe('# Root\n\n## A\n\n- a1\n\n## B\n\n## New\n\n- x\n')
    expect(parseMarkdown(out).children.map((c) => c.text)).toEqual(['A', 'B', 'New'])
  })
})

describe('misc', () => {
  it('titleFromFileName drops the extension', () => {
    expect(titleFromFileName('周会纪要.md')).toBe('周会纪要')
    expect(titleFromFileName('a.b.txt')).toBe('a.b')
  })
  it('appendPiece starts a new paragraph per recording and joins pieces within one', () => {
    expect(appendPiece('', '你好', true)).toBe('你好')
    expect(appendPiece('第一段', '第二段', true)).toBe('第一段\n\n第二段')
    expect(appendPiece('Hello', 'world', false)).toBe('Hello world')
  })
  it('appendPiece skips empty segments without stray spaces or blank lines', () => {
    expect(appendPiece('第一段', '', true)).toBe('第一段')
    expect(appendPiece('第一段', '  \n', false)).toBe('第一段')
    expect(appendPiece('Hello', '', false)).toBe('Hello')
    expect(appendPiece('', '', true)).toBe('')
    expect(appendPiece(appendPiece('Hello', '', false), 'world', false)).toBe('Hello world')
  })
})
