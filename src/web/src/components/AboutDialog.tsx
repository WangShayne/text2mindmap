import { Modal } from './Modal'
import { useI18n } from '../i18n'
import { APP_NAME } from '../../../shared/brand'

export const SMM_URL = 'https://github.com/wanglin2/mind-map'
export const SENSEVOICE_URL = 'https://github.com/QwenAudio/SenseVoice'

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  return (
    <Modal title={t('about')} onClose={onClose}>
      <p><strong>{APP_NAME}</strong> · {t('version')} {__APP_VERSION__}</p>
      <p>{t('aboutText', { app: APP_NAME })}</p>
      <div className="attribution">
        <p>{t('attributionZh')}，版权归源项目所有，<a href={SMM_URL} target="_blank" rel="noreferrer">{SMM_URL}</a></p>
        <p>{t('attribution')} <a href={SMM_URL} target="_blank" rel="noreferrer">SimpleMindMap</a> (MIT).</p>
      </div>
      <div className="attribution">
        <p>{t('asrAttribution')} <a href={SENSEVOICE_URL} target="_blank" rel="noreferrer">SenseVoice</a>{t('asrAttributionTail')}</p>
      </div>
      <p className="muted small">Third-party licenses: see THIRD_PARTY_NOTICES.md in the source repository and the Docker image.</p>
    </Modal>
  )
}
