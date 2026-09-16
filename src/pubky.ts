import { AuthFlowKind, Keypair, Pubky, PublicKey } from '@synonymdev/pubky'
import type { Session } from '@synonymdev/pubky'
import {
  APP_CAPABILITIES,
  APP_CLIENT_ID,
  HTTP_RELAY,
  IS_TESTNET,
  STORAGE_NAMESPACE,
  TESTNET_HOST,
} from './config'
import { createPassportCallbacks } from './passport'

const SESSION_KEY = STORAGE_NAMESPACE
  ? `${STORAGE_NAMESPACE}:${APP_CLIENT_ID}:session`
  : `${APP_CLIENT_ID}:session`
const AUTH_CANCELED_ERROR_NAME = 'AuthCanceled'
const AUTH_EXPIRED_ERROR_NAME = 'AuthExpired'
const AUTH_TIMEOUT_MS = 5 * 60_000
const AUTH_POLL_INTERVAL_MS = 250
const CLOSED_SIGNUP_MESSAGE =
  'This homeserver does not allow open signup. Start it with \'signup_mode = "open"\' for creating new identities.'

export const pubky = IS_TESTNET ? Pubky.testnet(TESTNET_HOST) : new Pubky()

export type AuthMethod = 'grant' | 'cookie'

export interface AppAuthFlow {
  attemptId: string
  authorizationUrl: string
  awaitApproval: Promise<Session>
  cancel: () => void
}

interface PollableAuthFlow {
  readonly authorizationUrl: string
  tryPollOnce(): Promise<Session | undefined>
  free(): void
}

type SavedSession =
  { version: 1; kind: 'grant'; id: string } | { version: 1; kind: 'cookie'; state: string }

export async function signupDevelopmentUser(homeserver: string) {
  const signer = pubky.signer(Keypair.random())
  const homeserverKey = PublicKey.from(homeserver.trim())

  try {
    await signer.signup(homeserverKey, null)
  } catch (error) {
    throw closedSignupError(error)
  }

  return signer.signin(APP_CLIENT_ID)
}

export async function startAuthFlow(authMethod: AuthMethod): Promise<AppAuthFlow> {
  const attemptId = crypto.randomUUID()
  const xCallback = createPassportCallbacks(attemptId)
  const flow: PollableAuthFlow =
    authMethod === 'grant'
      ? await pubky.startGrantAuthFlow(APP_CAPABILITIES, AuthFlowKind.signin(), {
          clientId: APP_CLIENT_ID,
          relay: HTTP_RELAY,
          xCallback,
        })
      : pubky.startCookieAuthFlow(APP_CAPABILITIES, AuthFlowKind.signin(), HTTP_RELAY, xCallback)
  return pollAuthFlow(flow, attemptId)
}

function pollAuthFlow(flow: PollableAuthFlow, attemptId: string): AppAuthFlow {
  return { attemptId, authorizationUrl: flow.authorizationUrl, ...awaitAuthApproval(flow) }
}

export async function saveSession(session: Session) {
  const cookie = session.cookie
  if (cookie) {
    try {
      saveSessionReference({ version: 1, kind: 'cookie', state: cookie.export() })
    } finally {
      cookie.free()
    }
    return
  }

  const store = pubky.browserSessionStore
  try {
    const stored = await store.save(session)
    saveSessionReference({ version: 1, kind: 'grant', id: stored.id })
  } finally {
    store.free()
  }
}

export async function restoreSavedSession() {
  const saved = readSavedSessionReference()
  if (!saved) return undefined

  try {
    if (saved.kind === 'cookie') return await pubky.restoreSession(saved.state)

    const store = pubky.browserSessionStore
    try {
      return await store.restore(saved.id)
    } finally {
      store.free()
    }
  } catch (error) {
    if (isInvalidSavedSessionError(error)) {
      await forgetSavedSession(saved)
      return undefined
    }

    throw error
  }
}

export async function signOut(session: Session) {
  const saved = readSavedSessionReference()
  await session.signout()
  await forgetSavedSession(saved)
}

export function isAuthCanceled(error: unknown) {
  return isErrorNamed(error, AUTH_CANCELED_ERROR_NAME)
}

export function isAuthExpired(error: unknown) {
  return isErrorNamed(error, AUTH_EXPIRED_ERROR_NAME)
}

function awaitAuthApproval(flow: PollableAuthFlow) {
  let canceled = false

  const cancel = () => {
    canceled = true
  }

  const awaitApproval = (async () => {
    try {
      const deadline = Date.now() + AUTH_TIMEOUT_MS
      while (!canceled && Date.now() < deadline) {
        const session = await flow.tryPollOnce()
        if (canceled) throw authCanceledError()
        if (session) return session
        await delay(AUTH_POLL_INTERVAL_MS)
      }

      if (canceled) throw authCanceledError()
      throw authExpiredError()
    } catch (error) {
      if (canceled) throw authCanceledError()
      if (isExpiredAuthError(error)) throw authExpiredError()
      throw error
    } finally {
      flow.free()
    }
  })()

  return {
    awaitApproval,
    cancel,
  }
}

async function forgetSavedSession(saved: SavedSession | undefined) {
  localStorage.removeItem(SESSION_KEY)
  if (!saved || saved.kind !== 'grant') return

  const store = pubky.browserSessionStore
  try {
    await store.remove(saved.id)
  } catch {
    // Local IndexedDB state may already be gone after a failed restore.
  } finally {
    store.free()
  }
}

function saveSessionReference(saved: SavedSession) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(saved))
}

function readSavedSessionReference(): SavedSession | undefined {
  const value = localStorage.getItem(SESSION_KEY)
  if (!value) return undefined

  try {
    const saved: unknown = JSON.parse(value)
    if (!isRecord(saved) || saved.version !== 1) return legacyGrantSession(value)
    if (saved.kind === 'grant' && typeof saved.id === 'string') {
      return { version: 1, kind: 'grant', id: saved.id }
    }
    if (saved.kind === 'cookie' && typeof saved.state === 'string') {
      return { version: 1, kind: 'cookie', state: saved.state }
    }
  } catch {
    return legacyGrantSession(value)
  }

  return legacyGrantSession(value)
}

function legacyGrantSession(id: string): SavedSession {
  return { version: 1, kind: 'grant', id }
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds))
}

function closedSignupError(error: unknown) {
  if (!isClosedSignupError(error)) {
    return error instanceof Error ? error : new Error(String(error))
  }

  const wrapped = new Error(CLOSED_SIGNUP_MESSAGE)
  wrapped.cause = error
  return wrapped
}

function isClosedSignupError(error: unknown) {
  const statusCode = errorStatusCode(error)
  const text = errorText(error).toLowerCase()

  if (statusCode === 400) return true
  if ((statusCode === 401 || statusCode === 403) && /signup|token|invite/.test(text)) {
    return true
  }

  return (
    isErrorNamed(error, 'AuthenticationError') ||
    text.includes('signup token required') ||
    text.includes('signup_mode') ||
    text.includes('token required')
  )
}

function isExpiredAuthError(error: unknown) {
  const text = errorText(error).toLowerCase()
  return text.includes('expired') || text.includes('timed out') || text.includes('timeout')
}

function isInvalidSavedSessionError(error: unknown) {
  return (
    isErrorNamed(error, 'AuthenticationError') ||
    isErrorNamed(error, 'InvalidInput') ||
    isErrorNamed(error, 'ClientStateError')
  )
}

function isErrorNamed(error: unknown, name: string) {
  return error instanceof Error && error.name === name
}

function errorStatusCode(error: unknown) {
  if (!isRecord(error) || !isRecord(error.data)) return undefined
  const statusCode = error.data.statusCode
  return typeof statusCode === 'number' ? statusCode : undefined
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause === undefined ? '' : ` ${errorText(error.cause)}`
    return `${error.name} ${error.message}${cause}`
  }

  return String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function authCanceledError() {
  const error = new Error('Pubky sign-in canceled')
  error.name = AUTH_CANCELED_ERROR_NAME
  return error
}

function authExpiredError() {
  const error = new Error('Pubky sign-in link expired. Generate a fresh link and try again.')
  error.name = AUTH_EXPIRED_ERROR_NAME
  return error
}
