import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { EditorState, Annotation } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, placeholder as cmPlaceholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxHighlighting, HighlightStyle, indentUnit } from '@codemirror/language'
import { tags } from '@lezer/highlight'

const mdStyle = HighlightStyle.define([
  { tag: tags.heading1, fontWeight: '700', fontSize: '1.15em', color: '#312e81' },
  { tag: tags.heading2, fontWeight: '700', color: '#4338ca' },
  { tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6], fontWeight: '600', color: '#4f46e5' },
  { tag: tags.processingInstruction, color: '#a5b4fc' },
  { tag: tags.list, color: '#0891b2' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: '#2563eb' },
  { tag: tags.url, color: '#64748b' },
  { tag: tags.monospace, color: '#be185d' },
  { tag: tags.quote, color: '#64748b' },
])

/** Marks a transaction as coming from outside the editor (map, generation, document load). */
export const External = Annotation.define<string>()

export interface EditorHandle {
  getText(): string
  setText(text: string, origin: string): void
}

interface Props {
  initial: string
  placeholder?: string
  onChange: (text: string, origin: string | null) => void
}

export const MarkdownEditor = forwardRef<EditorHandle, Props>(function MarkdownEditor({ initial, placeholder, onChange }, ref) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const cb = useRef(onChange)
  cb.current = onChange

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        extensions: [
          lineNumbers(),
          history(),
          highlightActiveLine(),
          indentUnit.of('  '),
          EditorState.tabSize.of(2),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          markdown(),
          syntaxHighlighting(mdStyle),
          EditorView.lineWrapping,
          cmPlaceholder(placeholder ?? ''),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged) return
            const origin = u.transactions.map((t) => t.annotation(External)).find(Boolean) ?? null
            cb.current(u.state.doc.toString(), origin)
          }),
        ],
      }),
    })
    view.current = v
    // Handy for automated tests and power users (document.querySelector('.cm-host').__editor)
    ;(host.current as unknown as { __editor?: EditorView }).__editor = v
    return () => v.destroy()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useImperativeHandle(ref, () => ({
    getText: () => view.current?.state.doc.toString() ?? '',
    setText: (text, origin) => {
      const v = view.current
      if (!v) return
      const cur = v.state.doc.toString()
      if (cur === text) return
      // Replace only the changed middle part so the cursor and scroll stay put.
      let start = 0
      while (start < cur.length && start < text.length && cur[start] === text[start]) start++
      let endCur = cur.length, endNew = text.length
      while (endCur > start && endNew > start && cur[endCur - 1] === text[endNew - 1]) { endCur--; endNew-- }
      v.dispatch({ changes: { from: start, to: endCur, insert: text.slice(start, endNew) }, annotations: External.of(origin) })
    },
  }))

  return <div className="cm-host" ref={host} />
})
