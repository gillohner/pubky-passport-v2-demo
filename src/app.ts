import type { Session } from '@synonymdev/pubky'
import { version as pubkySdkVersion } from '@synonymdev/pubky/package.json'
import { APP_NAME } from './config'
import {
  isAuthorizeRingLink,
  authViewHtml,
  renderRingSigninQr,
  updateAuthorizeLink,
  updateCopyButton,
  updateSigninView,
  type AuthorizationUrlKind,
  type SigninState,
} from './auth-ui'
import { startAppEventStream, type AppEvent, type AppEventStream } from './events'
import { eventStreamPanelHtml, updateEventList, updateEventStreamToggle } from './events-ui'
import { editorPanelHtml, filesPanelHtml, updateEditor, updateFilesList } from './files-ui'
import {
  copyTextToClipboard,
  disabledAttr,
  escapeHtml,
  formValue,
  formatError,
  statusMessage,
} from './html'
import {
  closePassportPopup,
  createPassportAuthorizationUrl,
  DEFAULT_PASSPORT_SETTINGS,
  openPassportPopup,
  passportOrigin,
  readCallbackOutcome,
  readPassportSettings,
  savePassportSettings,
  takePassportOutcome,
  type PassportLocation,
  type PassportOutcome,
  type PassportSettings,
} from './passport'
import {
  type AuthMethod,
  isAuthCanceled,
  isAuthExpired,
  restoreSavedSession,
  saveSession,
  signOut,
  signupDevelopmentUser,
  startAuthFlow,
  type AppAuthFlow,
} from './pubky'
import { deleteFile, filePath, listFiles, saveFile, type AppFile } from './storage'
import {
  cancelSignup,
  isMobileDevice,
  openSignup,
  readSignupReturn,
  takeSignupCompletion,
} from './signup'

interface State {
  busy?: string
  editingId?: string
  error?: string
  notice?: string
  noticePath?: string
  files: AppFile[]
  authFlow?: AppAuthFlow
  authMethod: AuthMethod
  passport: PassportSettings
  signin: SigninState
  session?: Session
  stopEventStream?: () => Promise<void>
  eventStreamEvents: AppEvent[]
}

const state: State = {
  authMethod: 'grant',
  eventStreamEvents: [],
  files: [],
  passport: { ...DEFAULT_PASSPORT_SETTINGS },
  signin: {},
}

let app: HTMLElement

export function start(root: HTMLElement) {
  app = root
  app.addEventListener('click', handleClick)
  app.addEventListener('change', handleChange)
  app.addEventListener('input', handleInput)
  app.addEventListener('submit', handleSubmit)
  window.addEventListener('message', handlePassportMessage)

  void init()
}

async function init() {
  let signupComplete = false
  try {
    const returned = await readSignupReturn()
    if (returned === 'forwarded') {
      app.innerHTML =
        '<main class="app-shell"><p class="status">Signup completed in Passport. You can close this window.</p></main>'
      return
    }
    signupComplete = returned === 'complete'
    state.passport = readPassportSettings()
  } catch (error) {
    setError(error)
  }
  const callbackOutcome = readCallbackOutcome()
  if (callbackOutcome) setPassportOutcome(callbackOutcome)
  mount()
  if (signupComplete) {
    void refreshSignin({ afterSignup: true })
    return
  }
  const callbackError = state.error
  await run('Restoring session...', async () => {
    const session = await restoreSavedSession()
    if (session) {
      await activateSession(session, 'Session restored.')
    }
  })

  if (callbackError) {
    state.error = callbackError
    updateStatus()
  }
  if (!state.session) await refreshSignin({ preserveError: Boolean(state.error) })
}

function mount() {
  const session = state.session

  app.innerHTML = `
    <main class="app-shell">
      <header class="app-header">
        <h1>${escapeHtml(APP_NAME)}</h1>
        ${session ? signedInHeader(session) : ''}
      </header>
      <p class="muted">A separate mainnet client for testing Passport v2 sign-in and account creation.</p>
      <div id="status" role="status" aria-live="polite">${statusHtml()}</div>
      <div id="view">${session ? signedInViewHtml() : authViewHtml(state.signin, state.busy, state.passport, state.authMethod)}</div>
      <footer class="app-footer">Built with <a href="https://www.npmjs.com/package/@synonymdev/pubky">Pubky SDK</a> v${pubkySdkVersion} · <a href="https://github.com/gillohner/pubky-passport-v2-demo">Source and testing guide</a></footer>
    </main>
  `

  void renderRingSigninQr(state.signin)
}

function signedInHeader(session: Session) {
  return `
    <div class="user-block">
      <button id="sign-out" type="button" ${disabledAttr(Boolean(state.busy))}>Sign out</button>
      <p class="pubky-id">${escapeHtml(session.info.publicKey.toString())}</p>
    </div>
  `
}

function signedInViewHtml() {
  return `
    <section class="grid">
      ${editorPanelHtml(state.files, state.editingId, state.busy)}
      ${filesPanelHtml(state.files, state.busy)}
      ${eventStreamPanelHtml(state.eventStreamEvents, Boolean(state.stopEventStream), state.busy)}
    </section>
  `
}

function statusHtml() {
  if (state.busy) return `<p class="status">${escapeHtml(state.busy)}</p>`
  if (state.error) return `<p class="status error">${escapeHtml(state.error)}</p>`
  if (state.notice) return `<p class="status">${statusMessage(state.notice, state.noticePath)}</p>`
  return ''
}

function updateStatus() {
  const status = app.querySelector('#status')
  if (!status) return
  status.innerHTML = statusHtml()
}

function canUseAuthorizationUrl() {
  const { authorizationUrl, expired, loading } = state.signin
  return !state.busy && Boolean(authorizationUrl) && !loading && !expired
}

function syncControls() {
  const busy = Boolean(state.busy)
  const loading = Boolean(state.signin.loading)
  const canUse = canUseAuthorizationUrl()
  const canUsePassport = canUse && Boolean(passportAuthorizationUrl())

  for (const button of app.querySelectorAll('button')) {
    switch (button.id) {
      case 'refresh-ring-signin':
        button.disabled = busy || loading
        break
      case 'copy-ring-authorization-url':
        button.disabled = !canUse
        break
      case 'copy-passport-authorization-url':
      case 'open-passport':
        button.disabled = !canUsePassport
        break
      case 'create-account':
      case 'create-account-in-tab':
        button.disabled =
          busy ||
          loading ||
          Boolean(state.signin.signupStep || state.signin.waitingForSignup) ||
          !passportOrigin(state.passport)
        break
      default:
        button.disabled = busy
        break
    }
  }

  for (const control of app.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
    '.passport-options input, .passport-options select',
  )) {
    control.disabled =
      busy || loading || Boolean(state.signin.signupStep || state.signin.waitingForSignup)
  }

  updateAuthorizeLink(canUse, state.signin.authorizationUrl)
}

function handleClick(event: MouseEvent) {
  const target = event.target
  if (!(target instanceof Element)) return

  if (isAuthorizeRingLink(target)) {
    if (!canUseAuthorizationUrl()) event.preventDefault()
    return
  }

  const button = target.closest<HTMLButtonElement>('button')
  if (!button || state.busy) return

  if (button.dataset.editId) {
    state.editingId = button.dataset.editId
    updateEditor(state.files, state.editingId, state.busy)
    return
  }

  if (button.dataset.deleteId) {
    void handleDeleteFile(button.dataset.deleteId)
    return
  }

  switch (button.id) {
    case 'refresh-ring-signin':
      void refreshSignin()
      break
    case 'copy-ring-authorization-url':
      void handleCopyAuthorizationUrl('ring')
      break
    case 'copy-passport-authorization-url':
      void handleCopyAuthorizationUrl('passport')
      break
    case 'open-passport':
      handleOpenPassport()
      break
    case 'create-account':
      handleCreateAccount(isMobileDevice())
      break
    case 'create-account-in-tab':
      handleCreateAccount(true)
      break
    case 'sign-out':
      void handleSignOut()
      break
    case 'new-file':
      state.editingId = undefined
      updateEditor(state.files, state.editingId, state.busy)
      break
    case 'toggle-event-stream':
      void toggleEventStream()
      break
    default:
      break
  }
}

function handleChange(event: Event) {
  const target = event.target
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return

  if (target.id === 'passport-location') {
    const location = parsePassportLocation(target.value)
    if (!location) return
    state.passport = { ...state.passport, location }
    savePassportSettings(state.passport)
    state.signin.passportCopied = false
    updateSigninView(state.signin, state.busy, state.passport, state.authMethod)
    syncControls()
    return
  }

  if (target instanceof HTMLInputElement && target.name === 'auth-method') {
    const authMethod = parseAuthMethod(target.value)
    if (!authMethod || authMethod === state.authMethod) return
    state.authMethod = authMethod
    void refreshSignin()
  }
}

function handleInput(event: Event) {
  const target = event.target
  if (!(target instanceof HTMLInputElement) || target.id !== 'custom-passport-origin') return

  state.passport = { ...state.passport, customOrigin: target.value }
  savePassportSettings(state.passport)
  const valid = Boolean(passportOrigin(state.passport))
  target.setAttribute('aria-invalid', String(!valid))
  const help = app.querySelector('#custom-passport-origin-help')
  if (help) help.className = valid ? 'muted' : 'field-error'
  syncControls()
}

function handleSubmit(event: SubmitEvent) {
  const form = event.target
  if (!(form instanceof HTMLFormElement)) return

  event.preventDefault()
  if (state.busy) return
  if (form.id === 'development-signup-form') void handleDevelopmentSignup(form)
  if (form.id === 'file-form') void handleSaveFile(form)
}

function openRingOnMobile(url: string) {
  if (!isMobileDevice()) return
  try {
    window.location.replace(url)
  } catch {
    // Keep the QR and explicit link if the browser rejects an automatic deeplink.
  }
}

async function refreshSignin({ preserveError = false, afterSignup = false } = {}) {
  const token = Symbol('signin')
  cancelSignup()
  cancelSignin()

  state.signin = {
    loading: true,
    token,
    signupStep: afterSignup ? 'signin' : undefined,
  }
  if (!preserveError) state.error = undefined
  state.notice = afterSignup ? 'Scan the sign-in QR with your new account in Ring.' : undefined
  updateStatus()
  updateSigninView(state.signin, state.busy, state.passport, state.authMethod)
  syncControls()

  try {
    const flow = await startAuthFlow(state.authMethod)
    if (!isActiveSignin(token)) {
      flow.cancel()
      void flow.awaitApproval.catch(() => {})
      return
    }

    state.authFlow = flow
    state.signin = {
      authorizationUrl: flow.authorizationUrl,
      token,
      signupStep: afterSignup ? 'signin' : undefined,
    }
    updateSigninView(state.signin, state.busy, state.passport, state.authMethod)
    syncControls()

    void handleApproval(flow, token)
    if (afterSignup) openRingOnMobile(flow.authorizationUrl)
  } catch (error) {
    if (!isActiveSignin(token)) return

    state.authFlow = undefined
    state.signin = {}
    setError(error)
    updateStatus()
    updateSigninView(state.signin, state.busy, state.passport, state.authMethod)
    syncControls()
  }
}

async function handleApproval(flow: AppAuthFlow, token: symbol) {
  try {
    const session = await flow.awaitApproval
    if (!isActiveSignin(token)) return

    state.authFlow = undefined
    await run('Completing Pubky sign-in...', async () => {
      await saveSession(session)
      await activateSession(session, 'Signed in with Pubky.')
    })
  } catch (error) {
    if (isAuthCanceled(error) || !isActiveSignin(token)) return

    state.authFlow = undefined
    closePassportPopup()
    const signupStep = state.signin.signupStep
    state.signin = isAuthExpired(error) ? { expired: true, token, signupStep } : { signupStep }
    setError(error)
    updateStatus()
    updateSigninView(state.signin, state.busy, state.passport, state.authMethod)
    syncControls()
  }
}

async function handleCopyAuthorizationUrl(kind: AuthorizationUrlKind) {
  const authorizationUrl = authorizationUrlFor(kind)
  if (!authorizationUrl || state.signin.expired) return

  try {
    await copyTextToClipboard(authorizationUrl)
    setCopied(kind, true)
    setNotice(kind === 'passport' ? 'Passport URL copied.' : 'Authorization URL copied.')
    updateStatus()
    updateCopyButton(kind, true)

    window.setTimeout(() => {
      if (authorizationUrlFor(kind) !== authorizationUrl) return
      setCopied(kind, false)
      updateCopyButton(kind, false)
    }, 2200)
  } catch (error) {
    setError(error)
    updateStatus()
  }
}

function handleOpenPassport() {
  const authorizationUrl = passportAuthorizationUrl()
  if (!authorizationUrl || state.signin.expired) return

  if (!openPassportPopup(authorizationUrl, handlePassportPopupClosed)) {
    setError(new Error('Passport popup was blocked. Allow popups for this site and try again.'))
    updateStatus()
    return
  }

  setNotice('Passport opened. Complete the authorization in the popup.')
  updateStatus()
}

function handleCreateAccount(inThisTab: boolean) {
  try {
    openSignup(state.passport, inThisTab, () => {
      setError(
        new Error(
          'Passport was closed. Create an account again, or sign in if you finished with Google.',
        ),
      )
      void refreshSignin({ preserveError: true })
    })
    cancelSignin()
    state.signin = { waitingForSignup: true }
    setNotice(
      'Continue in Passport. Finish verification and create your account in Ring there; return here to sign in.',
    )
    updateStatus()
    updateSigninView(state.signin, state.busy, state.passport, state.authMethod)
    syncControls()
  } catch (error) {
    setError(error)
    updateStatus()
  }
}

function handlePassportPopupClosed() {
  if (!state.authFlow || state.busy) return
  setError(new Error('Passport popup was closed before authorization completed.'))
  updateStatus()
  void refreshSignin({ preserveError: true })
}

function handlePassportMessage(event: MessageEvent) {
  let outcome: PassportOutcome | undefined
  try {
    if (takeSignupCompletion(event)) {
      void refreshSignin({ afterSignup: true })
      return
    }
    outcome = takePassportOutcome(event, state.authFlow?.attemptId)
  } catch (error) {
    setError(error)
    updateStatus()
    return
  }
  if (!outcome) return

  setPassportOutcome(outcome)
  updateStatus()

  if (outcome !== 'success') void refreshSignin({ preserveError: true })
}

function setPassportOutcome(outcome: PassportOutcome) {
  switch (outcome) {
    case 'success':
      setNotice('Passport reported success. Waiting for verified Pubky relay approval...')
      break
    case 'error':
      setError(new Error('Passport reported that it could not approve the request.'))
      break
    case 'cancel':
      setNotice('Passport authorization was cancelled.')
      break
  }
}

async function handleDevelopmentSignup(form: HTMLFormElement) {
  const formData = new FormData(form)
  const homeserver = formValue(formData, 'homeserver')

  await run('Creating identity...', async () => {
    const session = await signupDevelopmentUser(homeserver)
    await saveSession(session)
    await activateSession(session, 'Identity created and signed in.')
  })
}

async function handleSaveFile(form: HTMLFormElement) {
  const session = requireSession()
  const formData = new FormData(form)
  const title = formValue(formData, 'title')
  const body = formValue(formData, 'body')

  await run('Saving file...', async () => {
    const file = await saveFile(session, {
      id: state.editingId,
      title,
      body,
    })
    state.editingId = state.editingId ? file.id : undefined
    setNotice('File saved:', filePath(file.id))
    await refreshFiles()
    updateFilesList(state.files, state.busy)
    updateEditor(state.files, state.editingId, state.busy)
  })
}

async function handleDeleteFile(id: string) {
  const session = requireSession()

  await run('Deleting file...', async () => {
    await deleteFile(session, id)
    if (state.editingId === id) state.editingId = undefined
    setNotice('File deleted:', filePath(id))
    await refreshFiles()
    updateFilesList(state.files, state.busy)
    updateEditor(state.files, state.editingId, state.busy)
  })
}

async function handleSignOut() {
  const session = requireSession()

  await run('Signing out...', async () => {
    await stopEventStream()
    await signOut(session)
    state.session = undefined
    state.files = []
    state.editingId = undefined
    state.eventStreamEvents = []
    setNotice('Signed out.')
  })

  if (!state.session) await refreshSignin()
}

async function toggleEventStream() {
  if (state.stopEventStream) {
    await run('Stopping event stream...', async () => {
      await stopEventStream()
      setNotice('Event stream stopped.')
    })
    updateEventStreamToggle(false)
    return
  }

  const session = requireSession()
  await run('Starting event stream...', async () => {
    const eventStream = await startAppEventStream(session, (event) => {
      if (state.stopEventStream !== eventStream.stop) return
      state.eventStreamEvents = [event, ...state.eventStreamEvents].slice(0, 12)
      updateEventList(state.eventStreamEvents)
    })
    state.stopEventStream = eventStream.stop
    watchEventStream(eventStream)
    setNotice('Event stream started.')
  })
  updateEventStreamToggle(Boolean(state.stopEventStream))
}

function watchEventStream(eventStream: AppEventStream) {
  void eventStream.done.then(
    () => finishEventStream(eventStream),
    (error: unknown) => finishEventStream(eventStream, error),
  )
}

function finishEventStream(eventStream: AppEventStream, error?: unknown) {
  if (state.stopEventStream !== eventStream.stop) return

  state.stopEventStream = undefined
  if (error) setError(error)
  else setNotice('Event stream ended.')
  updateStatus()
  updateEventStreamToggle(false)
  syncControls()
}

async function stopEventStream() {
  const stop = state.stopEventStream
  state.stopEventStream = undefined
  if (stop) await stop()
}

async function refreshFiles() {
  const session = state.session
  if (!session) return

  state.files = await listFiles(session)
}

async function activateSession(session: Session, notice: string) {
  cancelSignup()
  cancelSignin()
  state.signin = {}
  state.session = session
  setNotice(notice)
  await refreshFiles()
}

function cancelSignin() {
  const flow = state.authFlow
  state.authFlow = undefined
  closePassportPopup()
  flow?.cancel()
}

function authorizationUrlFor(kind: AuthorizationUrlKind) {
  return kind === 'ring' ? state.signin.authorizationUrl : passportAuthorizationUrl()
}

function passportAuthorizationUrl() {
  if (state.signin.signupStep || state.signin.waitingForSignup) return undefined
  const authorizationUrl = state.signin.authorizationUrl
  return authorizationUrl
    ? createPassportAuthorizationUrl(authorizationUrl, state.passport)
    : undefined
}

function setCopied(kind: AuthorizationUrlKind, copied: boolean) {
  if (kind === 'ring') state.signin.ringCopied = copied
  else state.signin.passportCopied = copied
}

function isActiveSignin(token: symbol) {
  return state.signin.token === token
}

function parsePassportLocation(value: string): PassportLocation | undefined {
  return value === 'staging' || value === 'local' || value === 'custom' ? value : undefined
}

function parseAuthMethod(value: string): AuthMethod | undefined {
  return value === 'grant' || value === 'cookie' ? value : undefined
}

function setNotice(notice: string, path?: string) {
  state.error = undefined
  state.notice = notice
  state.noticePath = path
}

function setError(error: unknown) {
  state.error = formatError(error)
  state.notice = undefined
  state.noticePath = undefined
}

async function run(label: string, task: () => Promise<void>) {
  const hadSession = Boolean(state.session)
  state.busy = label
  state.error = undefined
  updateStatus()
  syncControls()

  try {
    await task()
  } catch (error) {
    setError(error)
  } finally {
    state.busy = undefined
  }

  if (Boolean(state.session) !== hadSession) {
    mount()
    return
  }

  updateStatus()
  syncControls()
}

function requireSession() {
  if (!state.session) throw new Error('No active Pubky session')
  return state.session
}
