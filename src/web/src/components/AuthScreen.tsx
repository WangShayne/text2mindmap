import { useState } from 'react'
import { api, type Me } from '../api'
import { useI18n } from '../i18n'
import { APP_NAME } from '../../../shared/brand'

export function AuthScreen({ mode, onDone }: { mode: 'setup' | 'login'; onDone: (u: Me) => void }) {
  const { t, lang, setLang } = useI18n()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (mode === 'setup' && password !== repeat) return setError(t('passwordsDiffer'))
    setBusy(true)
    try {
      const r = await api<{ user: Me }>('POST', mode === 'setup' ? '/api/setup' : '/api/auth/login', { username, password })
      onDone(r.user)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand big"><span className="logo" />{APP_NAME}</div>
        <h1>{mode === 'setup' ? t('setupTitle') : t('loginTitle')}</h1>
        {mode === 'setup' && <p className="muted">{t('setupHint')}</p>}
        <label>{t('username')}<input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></label>
        <label>{t('password')}<input type="password" autoComplete={mode === 'setup' ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {mode === 'setup' && <label>{t('passwordRepeat')}<input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required /></label>}
        {error && <div className="error">{error}</div>}
        <button className="btn primary" disabled={busy}>{mode === 'setup' ? t('createAccount') : t('signIn')}</button>
        <button type="button" className="link" onClick={() => setLang(lang === 'en' ? 'zh' : 'en')}>{t('language')}</button>
      </form>
    </div>
  )
}
