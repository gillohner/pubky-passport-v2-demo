import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_CLIENT_ID } from './config'
import { DEFAULT_PASSPORT_SETTINGS } from './passport'
import { cancelSignup, openSignup, readSignupReturn, takeSignupInvite } from './signup'

const HS = '8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo'
const ORIGIN = 'https://passport.staging.pubky.app'
const APP_ORIGIN = 'https://app.example'
const STORAGE_KEY = `${APP_CLIENT_ID}:signup-attempt`
let popup: {
  closed: boolean
  close: ReturnType<typeof vi.fn>
  postMessage: ReturnType<typeof vi.fn>
}
let location: URL & { assign: ReturnType<typeof vi.fn> }

beforeEach(() => {
  vi.useFakeTimers()
  const values = new Map<string, string>()
  const events = new EventTarget()
  location = Object.assign(new URL(`${APP_ORIGIN}/demo/`), { assign: vi.fn() })
  popup = { closed: false, close: vi.fn(), postMessage: vi.fn() }
  vi.stubGlobal('window', {
    location,
    open: vi.fn(() => popup),
    close: vi.fn(),
    opener: null,
    history: {
      state: null,
      replaceState: vi.fn((_state, _unused, path: string) => {
        location.href = new URL(path, location).href
      }),
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  })
  vi.stubGlobal('sessionStorage', {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
  })
})

afterEach(() => {
  cancelSignup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function start(inThisTab = false) {
  openSignup(DEFAULT_PASSPORT_SETTINGS, inThisTab, vi.fn())
  return (JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}') as { state: string }).state
}

function message(
  state: string,
  data: Record<string, unknown> = {},
  origin = ORIGIN,
  source: unknown = popup,
) {
  return {
    origin,
    source,
    data: {
      type: 'pubky-passport.signup-invite',
      version: 1,
      messageId: 'invite-1',
      state,
      hs: HS,
      st: 'single-use-test-token',
      ...data,
    },
  } as MessageEvent
}

function returnToApp(state: string, extra = '') {
  location.hash =
    new URLSearchParams({ hs: HS, st: 'single-use-test-token', state }).toString() + extra
}

describe('opening account creation', () => {
  it('passes only callback and fresh state, including for a custom deployment', () => {
    location.search = '?secret=must-not-leak'
    openSignup({ location: 'custom', customOrigin: 'https://passport-v2.example' }, false, vi.fn())
    const url = new URL(vi.mocked(window.open).mock.calls[0][0] as string)
    const params = new URLSearchParams(url.hash.slice(1))
    expect(url.origin + url.pathname).toBe('https://passport-v2.example/create-account')
    expect(url.search).toBe('')
    expect([...params.keys()].sort()).toEqual(['callback', 'state'])
    expect(params.get('callback')).toBe(`${APP_ORIGIN}/demo/`)
    expect(params.get('state')).toMatch(/^[A-Za-z0-9_-]{16,128}$/)
  })

  it('persists the attempt before same-tab navigation', () => {
    const state = start(true)
    const url = new URL(location.assign.mock.calls[0][0] as string)
    expect(new URLSearchParams(url.hash.slice(1)).get('state')).toBe(state)
    expect(window.open).not.toHaveBeenCalled()
  })

  it('cleans up after blocked or closed popups', () => {
    vi.mocked(window.open).mockReturnValueOnce(null)
    expect(() => start()).toThrow('popup was blocked')
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
    const closed = vi.fn()
    openSignup(DEFAULT_PASSPORT_SETTINGS, false, closed)
    popup.closed = true
    vi.advanceTimersByTime(500)
    expect(closed).toHaveBeenCalledOnce()
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('requires an HTTPS callback', () => {
    location.href = 'http://localhost:5173/'
    expect(() => start()).toThrow('HTTPS callback')
    expect(window.open).not.toHaveBeenCalled()
  })
})

describe('receiving invites', () => {
  it('consumes state before acknowledging and accepts only once', () => {
    const state = start()
    popup.postMessage.mockImplementation(() =>
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull(),
    )
    const event = message(state)
    expect(takeSignupInvite(event)).toEqual({ hs: HS, st: 'single-use-test-token' })
    expect(popup.postMessage).toHaveBeenCalledWith(
      {
        type: 'pubky-passport.signup-invite-ack',
        version: 1,
        messageId: 'invite-1',
      },
      ORIGIN,
    )
    expect(takeSignupInvite(event)).toBeUndefined()
    expect(popup.postMessage).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(3_200)
    expect(popup.close).toHaveBeenCalledOnce()
  })

  it.each([
    ['wrong origin', {}, 'https://attacker.example'],
    ['wrong state', { state: 'another-attempt-state' }, ORIGIN],
    ['wrong version', { version: 2 }, ORIGIN],
    ['wrong type', { type: 'pubky-passport.authorization-outcome' }, ORIGIN],
    ['invalid homeserver', { hs: 'x'.repeat(52) }, ORIGIN],
    ['prefixed homeserver', { hs: `pubky${HS}` }, ORIGIN],
    ['empty token', { st: ' ' }, ORIGIN],
    ['oversized token', { st: 'x'.repeat(1_025) }, ORIGIN],
    ['missing message id', { messageId: '' }, ORIGIN],
  ])('rejects %s', (_name, data, origin) => {
    const state = start()
    expect(takeSignupInvite(message(state, data, origin))).toBeUndefined()
    expect(popup.postMessage).not.toHaveBeenCalled()
    expect(sessionStorage.getItem(STORAGE_KEY)).not.toBeNull()
  })

  it('rejects messages from another window or expired attempts', () => {
    const state = start()
    expect(takeSignupInvite(message(state, {}, ORIGIN, {}))).toBeUndefined()
    vi.advanceTimersByTime(30 * 60_000)
    expect(takeSignupInvite(message(state))).toBeUndefined()
    expect(popup.postMessage).not.toHaveBeenCalled()
  })

  it('acknowledges a callback fallback without creating a second flow', () => {
    const state = start()
    expect(takeSignupInvite(message(state))).toBeDefined()
    const returned = message(
      state,
      { type: `${APP_CLIENT_ID}.signup-return`, messageId: 'fallback' },
      APP_ORIGIN,
    )
    expect(takeSignupInvite(returned)).toBeUndefined()
    expect(popup.postMessage).toHaveBeenLastCalledWith(
      {
        type: `${APP_CLIENT_ID}.signup-return-ack`,
        version: 1,
        messageId: 'fallback',
      },
      APP_ORIGIN,
    )
  })

  it('accepts a same-origin callback only from the original popup', () => {
    const state = start()
    const data = { type: `${APP_CLIENT_ID}.signup-return` }
    expect(takeSignupInvite(message(state, data, APP_ORIGIN, {}))).toBeUndefined()
    expect(takeSignupInvite(message(state, data, APP_ORIGIN))).toBeDefined()
  })
})

describe('navigation returns', () => {
  it('scrubs and consumes a matching return, then rejects a replay', async () => {
    const state = start(true)
    returnToApp(state)
    const result = readSignupReturn()
    expect(location.hash).toBe('')
    await expect(result).resolves.toEqual({ hs: HS, st: 'single-use-test-token' })
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
    returnToApp(state)
    await expect(readSignupReturn()).rejects.toThrow('expired or belongs to another tab')
  })

  it.each(['&st=duplicate', '&secret=unexpected'])(
    'rejects extra or duplicate fields: %s',
    async (extra) => {
      returnToApp(start(true), extra)
      await expect(readSignupReturn()).rejects.toThrow('Invalid create-account return')
      expect(location.hash).toBe('')
    },
  )

  it('rejects a wrong-state return without consuming the active attempt', async () => {
    start(true)
    returnToApp('wrong-but-valid-state')
    await expect(readSignupReturn()).rejects.toThrow('expired or belongs to another tab')
    expect(location.hash).toBe('')
    expect(sessionStorage.getItem(STORAGE_KEY)).not.toBeNull()
  })

  it('rejects an expired navigation return', async () => {
    const state = start(true)
    vi.advanceTimersByTime(30 * 60_000)
    returnToApp(state)
    await expect(readSignupReturn()).rejects.toThrow('expired or belongs to another tab')
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull()
  })
})
