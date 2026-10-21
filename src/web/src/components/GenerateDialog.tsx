import { useCallback, useState } from 'react'
import { VoiceInput, type AsrPublic } from './VoiceInput'
import { joinTranscript } from '../../../shared/wav'
import { useI18n } from '../i18n'
import { Modal } from './Modal'
import type { Selection } from '../mindmap/adapter'

export type GenRequest = { mode: 'full'; text: string } | { mode: 'expand'; selection: Selection; instructions: string }

export function GenerateDialog({ selection, chunkChars, maxChars, onStart, onClose, initialMode, asr }: {
  selection: Selection | null
  chunkChars: number
  maxChars: number
  initialMode: 'full' | 'expand'
  asr: AsrPublic
  onStart: (r: GenRequest) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const [mode, setMode] = useState<'full' | 'expand'>(initialMode)
  const [text, setText] = useState(() => sessionStorage.getItem('t2m.lastInput') ?? '')
  const [instructions, setInstructions] = useState('')
  const [voiceBusy, setVoiceBusy] = useState(false)
  const canStart = mode === 'full' ? !voiceBusy && text.trim().length > 0 && text.length <= maxChars : !!selection
  const appendVoice = useCallback((piece: string, newBlock: boolean) => {
    setText((prev) => (newBlock && prev.trim() ? `${prev.replace(/\s+$/, '')}\n\n${piece.trim()}` : joinTranscript(prev, piece)))
  }, [])
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
          <VoiceInput asr={asr} onAppend={appendVoice} onBusy={setVoiceBusy} />
          <textarea className="source" data-testid="source-text" autoFocus rows={14} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('pasteHere')} />
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
