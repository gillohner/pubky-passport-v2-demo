import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closePassportPopup,
  createPassportAuthorizationUrl,
  createPassportCallbacks,
  DEFAULT_PASSPORT_SETTINGS,
  LOCAL_PASSPORT_ORIGIN,
  openPassportPopup,
  passportOrigin,
  readCallbackOutcome,
  STAGING_PASSPORT_ORIGIN,
  takePassportOutcome,
  type PassportSettings,
} from './passport'

afterEach(() => {
  closePassportPopup()
  vi.unstubAllGlobals()
})

describe('Passport URL settings', () => {
  it('defaults to the staging Passport origin', () => {
    expect(passportOrigin(DEFAULT_PASSPORT_SETTINGS)).toBe(STAGING_PASSPORT_ORIGIN)
  })

  it('selects the local Passport origin', () => {
    expect(passportOrigin(settings('local'))).toBe(LOCAL_PASSPORT_ORIGIN)
  })

  it('normalizes a custom Passport URL to its HTTPS origin', () => {
    expect(passportOrigin(settings('custom', ' https://passport.example.com/path?q=1 '))).toBe(
      'https://passport.example.com',
    )
  })

  it.each([
    '',
    'not a url',
    'http://passport.example.com',
    'https://user:password@passport.example.com',
  ])('rejects an unsafe custom Passport URL: %s', (value) => {
    expect(passportOrigin(settings('custom', value))).toBeUndefined()
  })

  it('encodes the Pubky authorization URL exactly once', () => {
    const authorizationUrl =
      'pubkyauth://signin_grant?caps=%2Fpub%2Ftemplate%2F%3Arw&secret=relay-secret'

    expect(createPassportAuthorizationUrl(authorizationUrl, DEFAULT_PASSPORT_SETTINGS)).toBe(
      `${STAGING_PASSPORT_ORIGIN}/authorize#d=${encodeURIComponent(authorizationUrl)}`,
    )
  })
})

describe('Passport callbacks', () => {
  it('provides source plus correlated success, error, and cancel callbacks on HTTPS', () => {
    vi.stubGlobal('window', {
      location: new URL('https://app.example/basic/?old=value#fragment'),
    })

    expect(createPassportCallbacks('attempt-123')).toEqual({
      xSource: 'Pubky Passport v2 Demo',
      xSuccess: 'https://app.example/basic/?attempt=attempt-123&outcome=success',
      xError: 'https://app.example/basic/?attempt=attempt-123&outcome=error',
      xCancel: 'https://app.example/basic/?attempt=attempt-123&outcome=cancel',
    })
  })

  it('omits invalid HTTP callback URLs while preserving the source label', () => {
    vi.stubGlobal('window', {
      location: new URL('http://localhost:5173/basic/'),
    })

    expect(createPassportCallbacks('attempt-123')).toEqual({
      xSource: 'Pubky Passport v2 Demo',
    })
  })
})

describe('Passport popup', () => {
  it('keeps the opener channel and acknowledges a validated Passport outcome', () => {
    const popup = {
      closed: false,
      close: vi.fn(),
      focus: vi.fn(),
      postMessage: vi.fn(),
    }
    const open = vi.fn(() => popup)
    const clearInterval = vi.fn()
    const scheduledTimeouts = new Map<number, () => void>()
    vi.stubGlobal('window', {
      clearInterval,
      clearTimeout: vi.fn(),
      location: new URL('https://app.example/basic/'),
      open,
      outerHeight: 900,
      outerWidth: 1200,
      screenX: 0,
      screenY: 0,
      setInterval: vi.fn(() => 7),
      setTimeout: vi.fn((callback: () => void, delay: number) => {
        scheduledTimeouts.set(delay, callback)
        return delay
      }),
    })

    const authorizationUrl = `${STAGING_PASSPORT_ORIGIN}/authorize#d=request`
    expect(openPassportPopup(authorizationUrl, vi.fn())).toBe(true)
    expect(open).toHaveBeenCalledWith(
      authorizationUrl,
      expect.stringMatching(/^pubky-passport-/u),
      expect.stringContaining('popup=yes'),
    )
    expect(popup.focus).toHaveBeenCalledOnce()

    const message = {
      data: {
        type: 'pubky-passport.authorization-outcome',
        version: 1,
        outcome: 'success',
        messageId: 'message-123',
      },
      origin: STAGING_PASSPORT_ORIGIN,
      source: popup,
    } as unknown as MessageEvent
    const outcome = takePassportOutcome(message, 'attempt-123')

    expect(outcome).toBe('success')
    expect(popup.postMessage).toHaveBeenCalledWith(
      {
        type: 'pubky-passport.authorization-outcome-ack',
        version: 1,
        messageId: 'message-123',
      },
      STAGING_PASSPORT_ORIGIN,
    )
    expect(clearInterval).toHaveBeenCalledWith(7)
    expect(takePassportOutcome(message, 'attempt-123')).toBeUndefined()
    expect(popup.postMessage).toHaveBeenCalledTimes(2)
    expect(popup.close).not.toHaveBeenCalled()
    expect(scheduledTimeouts.get(3_000)).toBeTypeOf('function')
    scheduledTimeouts.get(3_000)?.()
    expect(scheduledTimeouts.get(3_100)).toBeTypeOf('function')
    scheduledTimeouts.get(3_100)?.()
    expect(popup.close).toHaveBeenCalledOnce()
  })

  it('reports a blocked popup when window.open throws', () => {
    vi.stubGlobal('window', {
      clearInterval: vi.fn(),
      clearTimeout: vi.fn(),
      location: new URL('https://app.example/basic/'),
      open: vi.fn(() => {
        throw new DOMException('Blocked', 'SecurityError')
      }),
      outerHeight: 900,
      outerWidth: 1200,
      screenX: 0,
      screenY: 0,
    })

    expect(openPassportPopup(`${STAGING_PASSPORT_ORIGIN}/authorize#d=request`, vi.fn())).toBe(false)
  })

  it('binds Passport messages to the exact custom origin that was opened', () => {
    const popup = popupWindow()
    stubPopupHost(popup)
    openPassportPopup('https://custom.passport.example/authorize#d=request', vi.fn())

    expect(
      takePassportOutcome(
        {
          data: {
            type: 'pubky-passport.authorization-outcome',
            version: 1,
            outcome: 'success',
            messageId: 'message-123',
          },
          origin: STAGING_PASSPORT_ORIGIN,
          source: popup,
        } as unknown as MessageEvent,
        'attempt-123',
      ),
    ).toBeUndefined()
    expect(popup.postMessage).not.toHaveBeenCalled()
  })

  it('accepts only a same-origin callback correlated to the active attempt', () => {
    const popup = popupWindow()
    stubPopupHost(popup)
    openPassportPopup(`${STAGING_PASSPORT_ORIGIN}/authorize#d=request`, vi.fn())

    const callbackMessage = {
      data: {
        type: 'basic-pubky-app.passport-return',
        attemptId: 'attempt-123',
        outcome: 'cancel',
      },
      origin: 'https://app.example',
      source: popup,
    } as unknown as MessageEvent

    expect(takePassportOutcome(callbackMessage, 'another-attempt')).toBeUndefined()
    expect(takePassportOutcome(callbackMessage, 'attempt-123')).toBe('cancel')
    expect(popup.close).toHaveBeenCalledOnce()
  })

  it('gives a queued callback message time to beat the popup-close watchdog', () => {
    const popup = popupWindow()
    const onClose = vi.fn()
    const host = stubPopupHost(popup)
    openPassportPopup(`${STAGING_PASSPORT_ORIGIN}/authorize#d=request`, onClose)

    popup.closed = true
    host.runCloseCheck()
    expect(onClose).not.toHaveBeenCalled()

    expect(
      takePassportOutcome(
        {
          data: {
            type: 'basic-pubky-app.passport-return',
            attemptId: 'attempt-123',
            outcome: 'success',
          },
          origin: 'https://app.example',
          source: popup,
        } as unknown as MessageEvent,
        'attempt-123',
      ),
    ).toBe('success')

    expect(host.clearTimeout).toHaveBeenCalledWith(8)
    host.finishGracePeriod()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('relays a callback navigation to its opener without treating it as authentication', () => {
    const opener = { closed: false, postMessage: vi.fn() }
    const replaceState = vi.fn()
    const close = vi.fn()
    vi.stubGlobal('window', {
      close,
      history: { replaceState, state: { existing: true } },
      location: new URL('https://app.example/basic/?attempt=attempt-123&outcome=error#preserved'),
      opener,
    })

    expect(readCallbackOutcome()).toBe('error')
    expect(replaceState).toHaveBeenCalledWith({ existing: true }, '', '/basic/#preserved')
    expect(opener.postMessage).toHaveBeenCalledWith(
      {
        type: 'basic-pubky-app.passport-return',
        attemptId: 'attempt-123',
        outcome: 'error',
      },
      'https://app.example',
    )
    expect(close).toHaveBeenCalledOnce()
  })

  it('scrubs but does not surface callback parameters without an opener', () => {
    const replaceState = vi.fn()
    vi.stubGlobal('window', {
      history: { replaceState, state: null },
      location: new URL('https://app.example/basic/?attempt=forged&outcome=success'),
      opener: null,
    })

    expect(readCallbackOutcome()).toBeUndefined()
    expect(replaceState).toHaveBeenCalledWith(null, '', '/basic/')
  })

  it('scrubs malformed callback parameters', () => {
    const replaceState = vi.fn()
    vi.stubGlobal('window', {
      history: { replaceState, state: null },
      location: new URL(
        'https://app.example/basic/?keep=value&attempt=attempt-123&outcome=bogus#fragment',
      ),
      opener: null,
    })

    expect(readCallbackOutcome()).toBeUndefined()
    expect(replaceState).toHaveBeenCalledWith(null, '', '/basic/?keep=value#fragment')
  })
})

function settings(location: PassportSettings['location'], customOrigin = ''): PassportSettings {
  return { location, customOrigin }
}

function popupWindow() {
  return {
    closed: false as boolean,
    close: vi.fn(),
    focus: vi.fn(),
    postMessage: vi.fn(),
  }
}

function stubPopupHost(popup: ReturnType<typeof popupWindow>) {
  let closeCheck: (() => void) | undefined
  let finishGracePeriod: (() => void) | undefined
  const clearTimeout = vi.fn()
  vi.stubGlobal('window', {
    clearInterval: vi.fn(),
    clearTimeout,
    location: new URL('https://app.example/basic/'),
    open: vi.fn(() => popup),
    outerHeight: 900,
    outerWidth: 1200,
    screenX: 0,
    screenY: 0,
    setInterval: vi.fn((callback: () => void) => {
      closeCheck = callback
      return 7
    }),
    setTimeout: vi.fn((callback: () => void) => {
      finishGracePeriod = callback
      return 8
    }),
  })

  return {
    clearTimeout,
    finishGracePeriod: () => finishGracePeriod?.(),
    runCloseCheck: () => closeCheck?.(),
  }
}
