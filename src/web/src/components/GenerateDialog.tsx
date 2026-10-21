import { useCallback, useState } from 'react'
import { VoiceInput, type AsrPublic } from './VoiceInput'
import { appendPiece } from '../audio/useTranscriber'
import { useI18n } from '../i18n'
import { Modal } from './Modal'
import type { Selection } from '../mindmap/adapter'

/** Full generation either replaces the document or, with `target`, appends the new outline under a node. */
export type GenRequest = { mode: 'full'; text: string; target?: Selection } | { mode: 'expand'; selection: Selection; instructions: string }

/** Replace vs append-to-selected-node choice, shown at the generate step when a node is selected. */
export function Placement({ selection, value, onChange }: { selection: Selection | null; value: 'replace' | 'append'; onChange: (v: 'replace' | 'append') => void }) {
  const { t } = useI18n()
  if (!selection) return null
  const node = selection.texts[selection.texts.length - 1] ?? ''
  return (
    <div className="placement" data-testid="placement">
      <span className="muted small">{t('placeLabel')}</span>
      <label className="radio"><input type="radio" checked={value === 'replace'} onChange={() => onChange('replace')} />{t('placeReplace')}</label>
      <label className="radio"><input type="radio" data-testid="place-append" checked={value === 'append'} onChange={() => onChange('append')} /><span className="ellipsis">{t('placeAppend', { node })}</span></label>
    </div>
  )
}

export function GenerateDialog({ selection, chunkChars, maxChars, onStart, onClose, initialMode, initialText, asr, isAdmin, onOpenSettings }: {
  selection: Selection | null
  chunkChars: number
  maxChars: number
  initialMode: 'full' | 'expand'
  /** Prefills the text (e.g. a dropped .txt file); otherwise the last draft is restored. */
  initialText?: string
  asr: AsrPublic
  isAdmin?: boolean
  /** Opens Settings at the given section; the dialog closes first and keeps the typed text. */
  onOpenSettings?: (section: 'asr') => void
  onStart: (r: GenRequest) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [mode, setMode] = useState<'full' | 'expand'>(initialMode)
  const [text, setText] = useState(() => initialText ?? sessionStorage.getItem('t2m.lastInput') ?? '')
  const [instructions, setInstructions] = useState('')
  const [place, setPlace] = useState<'replace' | 'append'>('replace')
  const [voiceBusy, setVoiceBusy] = useState(false)
  const canStart = mode === 'full' ? !voiceBusy && text.trim().length > 0 && text.length <= maxChars : !!selection
  const appendVoice = useCallback((piece: string, newBlock: boolean) => setText((prev) => appendPiece(prev, piece, newBlock)), [])
  const start = () => {
    if (mode === 'full') { sessionStorage.setItem('t2m.lastInput', text); onStart({ mode, text, ...(place === 'append' && selection ? { target: selection } : {}) }) }
    else if (selection) onStart({ mode, selection, instructions })
  }
  return (
    <Modal title={t('generateTitle')} onClose={onClose} wide footer={
      <>
        {mode === 'full' && <Placement selection={selection} value={place} onChange={setPlace} />}
        <span className="spacer" />
        <button className="btn" onClick={onClose}>{t('cancel')}</button>
        <button className="btn primary" data-testid="gen-start" disabled={!canStart} onClick={start}>{t('start')}</button>
      </>
    }>
      <div className="segmented">
        <button className={mode === 'full' ? 'on' : ''} onClick={() => setMode('full')}>{t('modeReplace')}</button>
        <button className={mode === 'expand' ? 'on' : ''} onClick={() => setMode('expand')}>{t('modeExpand')}</button>
      </div>
      {mode === 'full' ? (
        <>
          <textarea className="source" data-testid="source-text" autoFocus rows={14} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('pasteHere')} />
          <div className="hint row between">
            <span>{text.length > chunkChars ? t('willChunk') : ''}</span>
            <span className={text.length > maxChars ? 'error-text' : ''}>{t('chars', { n: text.length.toLocaleString() })}{text.length > maxChars ? ` / ${maxChars.toLocaleString()}` : ''}</span>
          </div>
          <VoiceInput asr={asr} onAppend={appendVoice} onBusy={setVoiceBusy} isAdmin={isAdmin} onOpenSettings={onOpenSettings && (() => { sessionStorage.setItem('t2m.lastInput', text); onClose(); onOpenSettings('asr') })} />
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
