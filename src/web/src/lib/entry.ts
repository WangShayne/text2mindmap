/**
 * Pure helpers behind the three input entries (text / record / upload) and drag-and-drop.
 * Kept free of DOM and React so they can be unit-tested in Node.
 */
import { parseMarkdown, serializeOutline } from '../../../shared/outline'

export type FileRoute = 'audio' | 'markdown' | 'text' | 'unsupported'

const AUDIO_EXT = /\.(mp3|m4a|wav|wave|webm|ogg|oga|opus|flac|aac|mp4|m4b|amr|3gp|caf|aiff?|wma|mkv|mov)$/i
const MD_EXT = /\.(md|markdown|mdown|mkd)$/i
const TEXT_EXT = /\.(txt|text|log|srt|vtt)$/i

/** Accept list for the single upload button. */
export const UPLOAD_ACCEPT = 'audio/*,video/webm,video/mp4,.mp3,.m4a,.wav,.webm,.ogg,.oga,.opus,.flac,.aac,.mp4,.md,.markdown,.txt,text/markdown,text/plain'

/**
 * Decides what a dropped or picked file is for:
 * audio -> speech recognition, .md -> imported as the map as-is, .txt -> text generation.
 * The extension wins over the MIME type (browsers report .md inconsistently, and .webm/.mp4 come as video/*).
 */
export function classifyFile(name: string, mime = ''): FileRoute {
  if (MD_EXT.test(name)) return 'markdown'
  if (TEXT_EXT.test(name)) return 'text'
  if (AUDIO_EXT.test(name)) return 'audio'
  const m = mime.toLowerCase()
  if (m === 'text/markdown' || m === 'text/x-markdown') return 'markdown'
  if (m.startsWith('audio/') || m === 'video/webm' || m === 'video/mp4') return 'audio'
  if (m.startsWith('text/')) return 'text'
  return 'unsupported'
}

/** True when the document has nothing besides (at most) the root heading. */
export function isTrivialMarkdown(md: string): boolean {
  const s = md.trim()
  return !s || /^#\s[^\n]*$/.test(s) || s === '#'
}

/**
 * Attaches a freshly generated outline under the node at `indices` (child positions from the root).
 * The generated root becomes one new child, keeping its subtree, all as list items.
 */
export function appendOutlineUnder(docMd: string, indices: number[], generatedMd: string, fallbackTitle: string): string {
  const tree = parseMarkdown(docMd, fallbackTitle)
  let node = tree
  for (const i of indices) node = node.children[i] ?? node
  const gen = parseMarkdown(generatedMd, '')
  const toList = (n: typeof gen): typeof gen => ({ text: n.text, kind: 'list', children: n.children.map(toList) })
  if (gen.text) node.children.push(toList(gen))
  else node.children.push(...gen.children.map(toList))
  return serializeOutline(tree)
}

/** Title for a document imported from a file name. */
export const titleFromFileName = (name: string) => name.replace(/\.[^.]+$/, '').trim()
