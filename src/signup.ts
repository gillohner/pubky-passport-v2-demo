import { APP_CLIENT_ID } from './config'
import { passportOrigin, type PassportSettings } from './passport'

interface SignupAttempt {
  state: string
  origin: string
  expiresAt: number
}

const STORAGE_KEY = `${APP_CLIENT_ID}:signup-attempt`
const COMPLETE_TYPE = 'pubky-passport.signup-complete'
const COMPLETE_ACK_TYPE = 'pubky-passport.signup-complete-ack'
const RETURN_TYPE = `${APP_CLIENT_ID}.signup-return`
const RETURN_ACK_TYPE = `${APP_CLIENT_ID}.signup-return-ack`
const ATTEMPT_LIFETIME_MS = 30 * 60_000
const CLOSE_DELAY_MS = 3_200

let attempt: SignupAttempt | undefined
let popup: Window | null | undefined
let closeTimer: number | undefined
let received = false

/** Open from a user gesture. Passport receives only the callback and a fresh state. */
export function openSignup(settings: PassportSettings, inThisTab: boolean, onClose: () => void) {
  const origin = passportOrigin(settings)
  if (!origin) throw new Error('Choose a valid HTTPS Passport URL first.')
  const callback = new URL(window.location.pathname, window.location.origin)
  if (callback.protocol !== 'https:') {
    throw new Error('Create account needs an HTTPS callback. Use the hosted demo or local HTTPS.')
  }

  cancelSignup()
  attempt = { state: crypto.randomUUID(), origin, expiresAt: Date.now() + ATTEMPT_LIFETIME_MS }
  // Save before opening: a callback in this tab must survive navigation to Passport.
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(attempt))
  const fragment = new URLSearchParams({ callback: callback.href, state: attempt.state })
  const url = `${origin}/create-account#${fragment}`

  if (inThisTab) {
    window.location.assign(url)
    return
  }

  popup = window.open(url, `passport-signup-${attempt.state}`, 'popup,width=520,height=760')
  if (!popup) {
    cancelSignup()
    throw new Error('Passport popup was blocked. Allow popups or choose “Create in this tab”.')
  }
  closeTimer = window.setInterval(() => {
    if (!popup?.closed) return
    cancelSignup()
    onClose()
  }, 500)
}

/** Validate, retain and acknowledge synchronously, before the caller starts SDK work. */
export function takeSignupCompletion(event: MessageEvent): boolean {
  if (!attempt || !popup || event.source !== popup || Date.now() >= attempt.expiresAt) return false
  const direct = event.origin === attempt.origin
  const returned = event.origin === window.location.origin
  if (!direct && !returned) return false
  const data: unknown = event.data
  if (!isRecord(data)) return false
  const expectedType = direct ? COMPLETE_TYPE : RETURN_TYPE
  if (
    data.type !== expectedType ||
    data.version !== 1 ||
    data.state !== attempt.state ||
    typeof data.messageId !== 'string' ||
    !data.messageId ||
    data.messageId.length > 128
  )
    return false

  if (received) {
    acknowledge(popup, event.origin, data.messageId, direct)
    return false
  }

  received = true
  sessionStorage.removeItem(STORAGE_KEY)
  window.clearInterval(closeTimer)
  acknowledge(popup, event.origin, data.messageId, direct)
  closeTimer = window.setTimeout(cancelSignup, CLOSE_DELAY_MS)
  return true
}

/** Capture and scrub the callback before rendering. A return never proves authentication. */
export async function readSignupReturn(): Promise<'complete' | 'forwarded' | undefined> {
  const hash = window.location.hash.slice(1)
  const params = new URLSearchParams(hash)
  if (!['signup', 'state'].some((key) => params.has(key))) return
  window.history.replaceState(
    window.history.state,
    '',
    window.location.pathname + window.location.search,
  )

  const keys = [...params.keys()]
  const state = params.get('state')
  if (
    hash.length > 8_192 ||
    keys.length !== 2 ||
    new Set(keys).size !== 2 ||
    keys.some((key) => !['signup', 'state'].includes(key)) ||
    !state ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(state) ||
    params.get('signup') !== 'complete'
  )
    throw new Error('Invalid create-account return. Start a new attempt.')

  if (await forwardReturnToOpener(state)) {
    sessionStorage.removeItem(STORAGE_KEY)
    window.close()
    return 'forwarded'
  }

  const pending = readAttempt()
  if (!pending || pending.state !== state) {
    throw new Error('This create-account attempt expired or belongs to another tab. Start again.')
  }
  sessionStorage.removeItem(STORAGE_KEY)
  return 'complete'
}

export function cancelSignup() {
  window.clearInterval(closeTimer)
  closeTimer = undefined
  attempt = undefined
  received = false
  sessionStorage.removeItem(STORAGE_KEY)
  const activePopup = popup
  popup = undefined
  try {
    if (activePopup && !activePopup.closed) activePopup.close()
  } catch {
    // Cross-origin popup cleanup is best effort; state is already discarded.
  }
}

export function isMobileDevice() {
  return (
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  )
}

function readAttempt(): SignupAttempt | undefined {
  const saved = sessionStorage.getItem(STORAGE_KEY)
  if (!saved) return
  try {
    const value: unknown = JSON.parse(saved)
    if (
      isRecord(value) &&
      typeof value.state === 'string' &&
      typeof value.origin === 'string' &&
      typeof value.expiresAt === 'number' &&
      Date.now() < value.expiresAt &&
      value.expiresAt <= Date.now() + ATTEMPT_LIFETIME_MS
    )
      return { state: value.state, origin: value.origin, expiresAt: value.expiresAt }
  } catch {
    // A malformed stored attempt cannot authorize a return.
  }
  sessionStorage.removeItem(STORAGE_KEY)
}

function acknowledge(target: Window, origin: string, messageId: string, direct: boolean) {
  target.postMessage(
    {
      type: direct ? COMPLETE_ACK_TYPE : RETURN_ACK_TYPE,
      version: 1,
      messageId,
    },
    origin,
  )
}

function forwardReturnToOpener(state: string): Promise<boolean> {
  const opener = window.opener as Window | null
  if (!opener || opener.closed) return Promise.resolve(false)
  const messageId = crypto.randomUUID()
  const message = { type: RETURN_TYPE, version: 1, messageId, state }
  return new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      const data: unknown = event.data
      if (
        event.source === opener &&
        event.origin === window.location.origin &&
        isRecord(data) &&
        data.type === RETURN_ACK_TYPE &&
        data.version === 1 &&
        data.messageId === messageId
      )
        finish(true)
    }
    const finish = (accepted: boolean) => {
      window.removeEventListener('message', onMessage)
      window.clearInterval(retry)
      window.clearTimeout(timeout)
      resolve(accepted)
    }
    const send = () => opener.postMessage(message, window.location.origin)
    const retry = window.setInterval(send, 250)
    const timeout = window.setTimeout(() => finish(false), 1_500)
    window.addEventListener('message', onMessage)
    send()
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
