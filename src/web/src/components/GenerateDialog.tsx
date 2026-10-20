import { useState } from 'react'
import { useI18n } from '../i18n'
import { Modal } from './Modal'
import type { Selection } from '../mindmap/adapter'

export type GenRequest = { mode: 'full'; text: string } | { mode: 'expand'; selection: Selection; instructions: string }

export function GenerateDialog({ selection, chunkChars, maxChars, onStart, onClose, initialMode }: {
  selection: Selection | null
  chunkChars: number
  maxChars: number
  initialMode: 'full' | 'expand'
  onStart: (r: GenRequest) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [mode, setMode] = useState<'full' | 'expand'>(initialMode)
  const [text, setText] = useState(() => sessionStorage.getItem('t2m.lastInput') ?? '')
  const [instructions, setInstructions] = useState('')
  const canStart = mode === 'full' ? text.trim().length > 0 && text.length <= maxChars : !!selection
  const start = () => {
    if (mode === 'full') { sessionStorage.setItem('t2m.lastInput', text); onStart({ mode, text }) }
    else if (selection) onStart({ mode, selection, instructions })
  }
  return (
    <Modal title={t('generateTitle')} onClose={onClose} wide footer={
      <>
        <button className="btn" onClick={onClose}>{t('cancel')}</button>
        <button className="btn primary" disabled={!canStart} onClick={start}>{t('start')}</button>
      </>
    }>
      <div className="segmented">
        <button className={mode === 'full' ? 'on' : ''} onClick={() => setMode('full')}>{t('modeReplace')}</button>
        <button className={mode === 'expand' ? 'on' : ''} onClick={() => setMode('expand')}>{t('modeExpand')}</button>
      </div>
      {mode === 'full' ? (
        <>
          <textarea className="source" autoFocus rows={14} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('pasteHere')} />
          <div className="hint row between">
            <span>{text.length > chunkChars ? t('willChunk') : ''}</span>
            <span className={text.length > maxChars ? 'error-text' : ''}>{t('chars', { n: text.length.toLocaleString() })}{text.length > maxChars ? ` / ${maxChars.toLocaleString()}` : ''}</span>
          </div>
        </>
      ) : (
        <>
          <p className="muted">{t('expandHint')}</p>
          <p><strong>{selection ? t('expandSelected', { path: selection.texts.join(' › ') }) : t('noSelection')}</strong></p>
          <input value={instructions} onChange={(e) => setInstructions(e.target.value)} placeholder={t('extraInstructions')} />
        </>
      )}
    </Modal>
  )
}
