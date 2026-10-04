import { Eye, EyeOff, ShieldCheck, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { getCountries, getCountryCallingCode, type CountryCode } from 'libphonenumber-js'
import { Button } from '../components/ui/Button'
import { ApiError, apiRequest } from '../lib/api'
import { useAuth } from '../context/AuthContext'

export type AuthMode = 'login' | 'register'

type AuthPageProps = {
  mode: AuthMode
}

type RegistrationStage = 1 | 2 | 3 | 4 | 5

const countryCodes = getCountries()
const countryName = new Intl.DisplayNames(['en'], { type: 'region' }); const countryLabel=(c: string) => { try { return countryName.of(c) || c } catch { return c } }
const countryFlag = (country: string) => String.fromCodePoint(...[...country].map((character) => 127397 + character.charCodeAt(0)))

function PhoneRegistrationFlow() {
  const navigate = useNavigate()
  const { refreshCurrentUser } = useAuth()
  const [stage, setStage] = useState<RegistrationStage>(1)
  const [challengeId, setChallengeId] = useState('')
  const [country, setCountry] = useState<CountryCode>('NG')
  const [phone, setPhone] = useState('')
  const [fullName, setFullName] = useState('')
  const [code, setCode] = useState('')
  const [privateDetails, setPrivateDetails] = useState({ dateOfBirth: '', countryCode: 'NG', region: '', city: '', address: '' })
  const [avatar, setAvatar] = useState<File | null>(null)
  const [username, setUsername] = useState('')
  const [consents, setConsents] = useState({ termsAccepted: false, privacyAccepted: false, guidelinesAccepted: false })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'We could not complete this step. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const startVerification = () => run(async () => {
    const response = await apiRequest<{ challengeId: string; deliveryMode: string }>('/api/auth/register/start', {
      method: 'POST',
      body: JSON.stringify({ countryCode: country, phone, fullName }),
    })
    setChallengeId(response.challengeId)
    setNotice(response.deliveryMode === 'development'
      ? 'Development verification is active. No SMS was sent; use the test provider configured by your developer.'
      : 'If this number can receive a verification code, one will be sent shortly.')
  })

  const verifyCode = () => run(async () => {
    await apiRequest('/api/auth/register/verify', { method: 'POST', body: JSON.stringify({ challengeId, code }) })
    setStage(2)
  })

  const savePrivateDetails = () => run(async () => {
    await apiRequest('/api/auth/register/stage/2', { method: 'PATCH', body: JSON.stringify(privateDetails) })
    setStage(3)
  })

  const saveAvatar = () => run(async () => {
    if (!avatar) {
      await apiRequest('/api/auth/register/stage/3', { method: 'PATCH', body: JSON.stringify({ skipAvatar: true }) })
    } else {
      const data = new FormData()
      data.append('avatar', avatar)
      await apiRequest('/api/auth/register/avatar', { method: 'POST', body: data })
    }
    setStage(4)
  })

  const saveUsername = () => run(async () => {
    const response = await apiRequest<{ available: boolean }>('/api/auth/register/username-availability?username=' + encodeURIComponent(username))
    if (!response.available) throw new Error('That username is unavailable.')
    await apiRequest('/api/auth/register/stage/4', { method: 'PATCH', body: JSON.stringify({ username, ...consents }) })
    setStage(5)
  })

  const completeRegistration = () => run(async () => {
    await apiRequest('/api/auth/register/complete', { method: 'POST' })
    await refreshCurrentUser()
    navigate('/', { replace: true })
  })

  const resendCode = () => run(async () => {
    await apiRequest('/api/auth/register/resend', { method: 'POST', body: JSON.stringify({ challengeId }) })
    setNotice('If eligible, a new verification code has been sent.')
  })

  return (
    <div className="min-h-screen bg-slate-100 px-4 py-10 text-slate-900">
      <div className="mx-auto grid w-full max-w-5xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-xl lg:grid-cols-[0.8fr_1.2fr]">
        <aside className="hidden flex-col justify-between bg-emerald-950 p-8 text-white lg:flex">
          <div>
            <Link to="/" className="text-sm font-bold tracking-[0.25em]">NOVAKOKO</Link>
            <p className="mt-16 max-w-xs text-3xl font-semibold leading-tight">A place to meet, share and belong.</p>
          </div>
          <div className="border-t border-white/20 pt-5 text-sm leading-6 text-emerald-100">
            <ShieldCheck className="mb-3 h-5 w-5" aria-hidden="true" />
            Your private registration details are kept out of public profiles.
          </div>
        </aside>
        <main className="p-6 sm:p-10">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase text-emerald-700">Account registration · {stage} of 5</p>
              <h1 className="mt-2 text-3xl font-semibold">{['', 'Your phone', 'Your details', 'Profile picture', 'Choose a username', 'Ready for NOVAKOKO'][stage]}</h1>
            </div>
            <Sparkles className="h-5 w-5 text-emerald-700" aria-hidden="true" />
          </div>
          <div className="mt-6 grid grid-cols-5 gap-1" aria-label={`Registration stage ${stage} of 5`}>
            {[1, 2, 3, 4, 5].map((item) => <div key={item} className={`h-1.5 rounded-full ${item <= stage ? 'bg-emerald-700' : 'bg-slate-200'}`} />)}
          </div>

          {stage === 1 && !challengeId ? (
            <form className="mt-8 space-y-5" onSubmit={(event) => { event.preventDefault(); void startVerification() }}>
              <label className="block text-sm font-medium">Full name<input required minLength={2} maxLength={100} autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-3" /></label>
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
                <label className="block text-sm font-medium">Country
                  <select value={country} onChange={(event) => { const nextCountry = event.target.value as CountryCode; setCountry(nextCountry); setPrivateDetails((current) => ({ ...current, countryCode: nextCountry })) }} className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-3">
                    {countryCodes.map((item) => <option key={item} value={item}>{countryFlag(item)} {countryLabel(item)} (+{getCountryCallingCode(item)})</option>)}
                  </select>
                </label>
                <label className="block text-sm font-medium">Phone number
                  <div className="mt-2 flex rounded-lg border border-slate-300 focus-within:ring-2 focus-within:ring-emerald-600"><span className="flex items-center border-r border-slate-200 px-3 text-slate-600">+{getCountryCallingCode(country)}</span><input required type="tel" autoComplete="tel-national" value={phone} onChange={(event) => setPhone(event.target.value)} className="min-w-0 flex-1 rounded-r-lg px-3 py-3 outline-none" /></div>
                </label>
              </div>
              <Button type="submit" variant="primary" size="lg" className="w-full" disabled={busy}>{busy ? 'Please wait...' : 'Send verification code'}</Button>
            </form>
          ) : null}

          {stage === 1 && challengeId ? (
            <form className="mt-8 space-y-5" onSubmit={(event) => { event.preventDefault(); void verifyCode() }}>
              <p className="text-sm text-slate-600">Enter the six-digit code for your phone. Your account is not created until all stages are complete.</p>
              <label className="block text-sm font-medium">Verification code<input required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-3 text-lg tracking-widest" /></label>
              <Button type="submit" variant="primary" size="lg" className="w-full" disabled={busy}>{busy ? 'Verifying...' : 'Verify phone'}</Button>
              <button type="button" onClick={() => void resendCode()} disabled={busy} className="w-full text-sm font-semibold text-emerald-800 underline">Resend code</button>
            </form>
          ) : null}

          {stage === 2 ? (
            <form className="mt-8 grid gap-4 sm:grid-cols-2" onSubmit={(event) => { event.preventDefault(); void savePrivateDetails() }}>
              <label className="block text-sm font-medium">Date of birth<input required type="date" max={new Date(Date.now() - 13 * 365.25 * 86400000).toISOString().slice(0, 10)} value={privateDetails.dateOfBirth} onChange={(event) => setPrivateDetails({ ...privateDetails, dateOfBirth: event.target.value })} className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-3" /></label>
              <label className="block text-sm font-medium">Country<select required value={privateDetails.countryCode} onChange={(event) => setPrivateDetails({ ...privateDetails, countryCode: event.target.value })} className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-3">{countryCodes.map((item) => <option key={item} value={item}>{countryFlag(item)} {countryLabel(item)}</option>)}</select></label>
              <label className="block text-sm font-medium">State / region<input required maxLength={100} value={privateDetails.region} onChange={(event) => setPrivateDetails({ ...privateDetails, region: event.target.value })} className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-3" /></label>
              <label className="block text-sm font-medium">City<input required maxLength={100} value={privateDetails.city} onChange={(event) => setPrivateDetails({ ...privateDetails, city: event.target.value })} className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-3" /></label>
              <label className="block text-sm font-medium sm:col-span-2">Address<input required maxLength={300} autoComplete="street-address" value={privateDetails.address} onChange={(event) => setPrivateDetails({ ...privateDetails, address: event.target.value })} className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-3" /></label>
              <p className="text-xs text-slate-500 sm:col-span-2">These details are private and are not shown on your profile.</p>
              <Button type="submit" variant="primary" size="lg" className="sm:col-span-2" disabled={busy}>{busy ? 'Saving...' : 'Continue'}</Button>
            </form>
          ) : null}

          {stage === 3 ? (
            <form className="mt-8 space-y-5" onSubmit={(event) => { event.preventDefault(); void saveAvatar() }}>
              <label className="block text-sm font-medium">Profile picture<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setAvatar(event.target.files?.[0] ?? null)} className="mt-2 block w-full rounded-lg border border-slate-300 p-3" /></label>
              <p className="text-sm text-slate-500">JPEG, PNG, or WebP, up to 4 MB. NOVAKOKO processes and resizes the image before storage.</p>
              <div className="flex flex-col gap-3 sm:flex-row"><Button type="submit" variant="primary" size="lg" className="flex-1" disabled={busy}>{busy ? 'Uploading...' : avatar ? 'Upload picture' : 'Use default picture'}</Button>{avatar ? <button type="button" onClick={() => setAvatar(null)} className="rounded-lg border border-slate-300 px-4 py-3 text-sm">Remove selection</button> : null}</div>
            </form>
          ) : null}

          {stage === 4 ? (
            <form className="mt-8 space-y-5" onSubmit={(event) => { event.preventDefault(); void saveUsername() }}>
              <label className="block text-sm font-medium">Username<input required minLength={3} maxLength={30} pattern="[A-Za-z0-9_]+" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-3" /><span className="mt-1 block text-xs text-slate-500">Letters, numbers and underscores. Usernames are case-insensitive.</span></label>
              <div className="space-y-3 rounded-lg border border-slate-200 p-4 text-sm">
                {([['termsAccepted', 'Terms of Service'], ['privacyAccepted', 'Privacy Policy'], ['guidelinesAccepted', 'Community Guidelines']] as const).map(([key, title]) => <label key={key} className="flex items-start gap-3"><input required type="checkbox" checked={consents[key]} onChange={(event) => setConsents({ ...consents, [key]: event.target.checked })} className="mt-1 h-4 w-4 accent-emerald-700" /><span>I accept the {title}.</span></label>)}
              </div>
              <Button type="submit" variant="primary" size="lg" className="w-full" disabled={busy}>{busy ? 'Checking...' : 'Continue'}</Button>
            </form>
          ) : null}

          {stage === 5 ? (
            <div className="mt-8 space-y-5">
              <p className="text-slate-600">Your phone is verified. Your private details are encrypted, and account creation will establish this device session.</p>
              <Button type="button" variant="primary" size="lg" className="w-full" onClick={() => void completeRegistration()} disabled={busy}>{busy ? 'Creating account...' : 'Create NOVAKOKO account'}</Button>
            </div>
          ) : null}

          {error ? <p className="mt-5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800" role="alert">{error}</p> : null}
          {notice ? <p className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900" role="status">{notice}</p> : null}
          <p className="mt-8 text-center text-sm text-slate-600">Already have an account? <Link to="/login" className="font-semibold text-emerald-800 underline">Log in</Link></p>
        </main>
      </div>
    </div>
  )
}

export function AuthPage({ mode }: AuthPageProps) {
  const navigate = useNavigate()
  const { login, register, refreshCurrentUser, isLoading: authLoading } = useAuth()
  const [showPassword, setShowPassword] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [phoneLoginMode, setPhoneLoginMode] = useState(false)
  const [phoneCountry, setPhoneCountry] = useState<CountryCode>('NG')
  const [phoneNumber, setPhoneNumber] = useState('')
  const [phoneChallengeId, setPhoneChallengeId] = useState('')
  const [phoneCode, setPhoneCode] = useState('')
  const [phoneNotice, setPhoneNotice] = useState('')
  const [formData, setFormData] = useState({ name: '', email: '', password: '', confirmPassword: '', communityRulesAccepted: false })
  const [formError, setFormError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const isRegister = mode === 'register'

  if (isRegister) return <PhoneRegistrationFlow />

  const submitLabel = useMemo(() => (isRegister ? 'Create account' : 'Log in'), [isRegister])

  const handleChange = (field: 'name' | 'email' | 'password' | 'confirmPassword' | 'communityRulesAccepted', value: string | boolean) => {
    setFormData((current) => ({ ...current, [field]: value }))
    setFieldErrors((current) => ({ ...current, [field]: '' }))
    setFormError('')
  }

  const getFriendlyErrorMessage = (error: unknown) => {
    if (error instanceof ApiError) {
      switch (error.status) {
        case 400:
          return 'Please check your details and try again.'
        case 401:
          return 'Your email or password is incorrect.'
        case 403:
          return 'This account is not allowed to sign in right now.'
        case 409:
          return 'An account with this email already exists.'
        case 429:
          return 'Too many attempts. Please wait a moment and try again.'
        case 500:
          return 'We could not complete this request right now. Please try again later.'
        default:
          return error.message || 'Something went wrong. Please try again.'
      }
    }

    return 'Something went wrong. Please try again.'
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormError('')
    setFieldErrors({})

    const nextFieldErrors: Record<string, string> = {}
    const name = formData.name.trim()
    const email = formData.email.trim()
    const password = formData.password

    if (isRegister && name.length < 2) {
      nextFieldErrors.name = 'Please enter a valid name.'
    }

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      nextFieldErrors.email = 'Please enter a valid email address.'
    }

    if (password.length < 8) {
      nextFieldErrors.password = 'Password must be at least 8 characters.'
    }

    if (isRegister && formData.confirmPassword !== password) {
      nextFieldErrors.confirmPassword = 'Passwords do not match.'
    }

    if (isRegister && !formData.communityRulesAccepted) {
      nextFieldErrors.communityRulesAccepted = 'You must accept the NOVAKOKO Community & Safety Rules.'
    }

    if (Object.keys(nextFieldErrors).length > 0) {
      setFieldErrors(nextFieldErrors)
      return
    }

    setIsSubmitting(true)

    try {
      if (isRegister) {
        await register(name, email, password, formData.communityRulesAccepted)
      } else {
        await login(email, password)
      }

      navigate('/', { replace: true })
    } catch (error) {
      setFormError(getFriendlyErrorMessage(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handlePhoneSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFormError('')
    setPhoneNotice('')
    setIsSubmitting(true)

    try {
      if (!phoneChallengeId) {
        const response = await apiRequest<{ challengeId?: string; deliveryMode?: string }>('/api/auth/phone/start', {
          method: 'POST',
          body: JSON.stringify({ countryCode: phoneCountry, phone: phoneNumber }),
        })
        if (response.challengeId) setPhoneChallengeId(response.challengeId)
        setPhoneNotice(response.deliveryMode === 'development'
          ? 'Development verification is active. No SMS was sent; use the test provider configured by your developer.'
          : 'If this number has an account, a verification code will be sent shortly.')
        return
      }

      await apiRequest('/api/auth/phone/verify', {
        method: 'POST',
        body: JSON.stringify({ challengeId: phoneChallengeId, code: phoneCode }),
      })
      await refreshCurrentUser()
      navigate('/', { replace: true })
    } catch (error) {
      setFormError(getFriendlyErrorMessage(error))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-100 via-violet-50 to-cyan-50 p-4">
      <div className="grid w-full max-w-5xl overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-2xl lg:grid-cols-[1.1fr_0.9fr]">
        <div className="hidden bg-gradient-to-br from-violet-600 via-indigo-600 to-cyan-500 p-8 text-white lg:flex lg:flex-col lg:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/15 text-xl font-black shadow-lg shadow-violet-500/20">
                N
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.32em] text-violet-100">NOVAKOKO</p>
                <p className="text-sm text-violet-100">Safe social connection</p>
              </div>
            </div>

            <div className="mt-12 max-w-md">
              <p className="text-xs uppercase tracking-[0.28em] text-violet-100">Family-first network</p>
              <h1 className="mt-4 text-4xl font-semibold leading-tight">A calmer, more meaningful place to connect.</h1>
            </div>
          </div>

          <div className="rounded-[28px] border border-white/15 bg-white/10 p-5 backdrop-blur-sm">
            <div className="flex items-center gap-3">
              <ShieldCheck className="h-5 w-5 text-emerald-300" aria-hidden="true" />
              <p className="font-semibold">Safety-first moderation</p>
            </div>
            <p className="mt-3 text-sm leading-6 text-violet-100">
              Sexual/adult content, harassment, scams and abusive behavior are not allowed. We help keep every space respectful, secure and welcoming.
            </p>
          </div>
        </div>

        <div className="p-6 sm:p-8">
          <div className="mb-6 flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-violet-600">{isRegister ? 'Create account' : 'Welcome back'}</p>
              <h2 className="mt-2 text-3xl font-semibold text-slate-900">{isRegister ? 'Join NOVAKOKO' : 'Log in to NOVAKOKO'}</h2>
            </div>
            <Sparkles className="h-5 w-5 text-violet-600" aria-hidden="true" />
          </div>

          <form className="space-y-4" onSubmit={phoneLoginMode ? handlePhoneSubmit : handleSubmit} noValidate>
            {phoneLoginMode ? (
              <>
                {!phoneChallengeId ? (
                  <>
                    <label className="block text-sm font-medium text-slate-700">Country
                      <select value={phoneCountry} onChange={(event) => setPhoneCountry(event.target.value as CountryCode)} className="mt-1.5 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5">
                        {countryCodes.map((item) => <option key={item} value={item}>{countryFlag(item)} {countryLabel(item)} (+{getCountryCallingCode(item)})</option>)}
                      </select>
                    </label>
                    <label className="block text-sm font-medium text-slate-700">Phone number
                      <input type="tel" autoComplete="tel" required value={phoneNumber} onChange={(event) => setPhoneNumber(event.target.value)} className="mt-1.5 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5" />
                    </label>
                  </>
                ) : (
                  <label className="block text-sm font-medium text-slate-700">Verification code
                    <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={phoneCode} onChange={(event) => setPhoneCode(event.target.value)} className="mt-1.5 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-lg" />
                  </label>
                )}
              </>
            ) : <>
            {isRegister ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm font-medium text-slate-700">
                  Full name
                  <input
                    value={formData.name}
                    onChange={(event) => handleChange('name', event.target.value)}
                    className="mt-1.5 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-slate-800 focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100"
                    aria-invalid={Boolean(fieldErrors.name)}
                  />
                  {fieldErrors.name ? <span className="mt-1 block text-xs text-rose-600">{fieldErrors.name}</span> : null}
                </label>
              </div>
            ) : null}

            <label className="block text-sm font-medium text-slate-700">
              Email
              <input
                type="email"
                value={formData.email}
                onChange={(event) => handleChange('email', event.target.value)}
                placeholder="name@example.com"
                className="mt-1.5 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-slate-800 focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100"
                aria-invalid={Boolean(fieldErrors.email)}
              />
              {fieldErrors.email ? <span className="mt-1 block text-xs text-rose-600">{fieldErrors.email}</span> : null}
            </label>

            <label className="block text-sm font-medium text-slate-700">
              Password
              <div className="relative mt-1.5">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={formData.password}
                  onChange={(event) => handleChange('password', event.target.value)}
                  placeholder="••••••••"
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 pr-11 text-slate-800 focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100"
                  aria-invalid={Boolean(fieldErrors.password)}
                />
                <button
                  type="button"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowPassword((value) => !value)}
                  className="absolute inset-y-0 right-3 flex items-center text-slate-500 transition hover:text-slate-700"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                </button>
              </div>
              {fieldErrors.password ? <span className="mt-1 block text-xs text-rose-600">{fieldErrors.password}</span> : null}
            </label>

            {isRegister ? (
              <label className="block text-sm font-medium text-slate-700">
                Confirm password
                <input
                  type="password"
                  value={formData.confirmPassword}
                  onChange={(event) => handleChange('confirmPassword', event.target.value)}
                  placeholder="Repeat your password"
                  className="mt-1.5 w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-slate-800 focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100"
                  aria-invalid={Boolean(fieldErrors.confirmPassword)}
                />
                {fieldErrors.confirmPassword ? <span className="mt-1 block text-xs text-rose-600">{fieldErrors.confirmPassword}</span> : null}
              </label>
            ) : null}

            {isRegister ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <p className="font-semibold">NOVAKOKO Community & Safety Rules</p>
                <p className="mt-2 leading-6 text-amber-800">
                  NOVAKOKO is a family-friendly platform and does not allow pornography, explicit sexual content, sexual solicitation, exploitation, sexual harassment, sexually explicit images/videos, or links/files promoting prohibited sexual content.
                </p>
                <label className="mt-3 flex items-start gap-3 text-sm text-amber-900">
                  <input
                    type="checkbox"
                    checked={formData.communityRulesAccepted}
                    onChange={(event) => handleChange('communityRulesAccepted', event.target.checked)}
                    className="mt-1 h-4 w-4 rounded border-amber-300 text-violet-600 focus:ring-violet-500"
                    aria-invalid={Boolean(fieldErrors.communityRulesAccepted)}
                  />
                  <span>
                    I understand and agree to follow NOVAKOKO Community & Safety Rules.
                  </span>
                </label>
                {fieldErrors.communityRulesAccepted ? <span className="mt-2 block text-xs text-rose-600">{fieldErrors.communityRulesAccepted}</span> : null}
              </div>
            ) : (
              <label className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
                <input type="checkbox" className="mt-1 h-4 w-4 rounded border-slate-300 text-violet-600 focus:ring-violet-500" />
                <span>Keep me signed in on this device.</span>
              </label>
            )}
            </>}

            {formError ? (
              <div className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700" aria-live="polite">
                {formError}
              </div>
            ) : null}

            <Button type="submit" variant="primary" size="lg" className="mt-2 w-full" disabled={isSubmitting || authLoading}>
              {isSubmitting ? 'Please wait...' : phoneLoginMode ? (phoneChallengeId ? 'Verify code' : 'Send code') : submitLabel}
            </Button>
          </form>

          {phoneNotice ? <p className="mt-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900" role="status">{phoneNotice}</p> : null}

          <div className="mt-6 text-center text-sm text-slate-500">
            {isRegister ? 'Already have an account?' : 'Need an account?'}{' '}
            <Link to={isRegister ? '/login' : '/register'} className="font-semibold text-violet-700 hover:text-violet-800">
              {isRegister ? 'Log in' : 'Register'}
            </Link>
          </div>
          {!isRegister ? <button type="button" onClick={() => { setPhoneLoginMode((current) => !current); setPhoneChallengeId(''); setPhoneCode(''); setFormError(''); setPhoneNotice('') }} className="mt-4 w-full text-center text-sm font-semibold text-violet-700 hover:text-violet-800">
            {phoneLoginMode ? 'Use email and password' : 'Log in with phone verification'}
          </button> : null}
        </div>
      </div>
    </div>
  )
}
