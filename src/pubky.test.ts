import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => {
  const grantSession = { kind: 'grant-session' }
  const cookieSession = { kind: 'cookie-session' }
  const grantFlow = {
    authorizationUrl: 'pubkyauth://signin_grant?secret=grant-secret',
    free: vi.fn(),
    tryPollOnce: vi.fn(async () => grantSession),
  }
  const cookieFlow = {
    authorizationUrl: 'pubkyauth://signin?secret=cookie-secret',
    free: vi.fn(),
    tryPollOnce: vi.fn(async () => cookieSession),
  }
  const sessionStore = {
    free: vi.fn(),
    remove: vi.fn(async () => undefined),
    restore: vi.fn(),
    save: vi.fn(),
  }
  const client = {
    browserSessionStore: sessionStore,
    restoreSession: vi.fn(),
    startCookieAuthFlow: vi.fn(() => cookieFlow),
    startGrantAuthFlow: vi.fn(async () => grantFlow),
  }

  return { client, cookieFlow, cookieSession, grantFlow, grantSession, sessionStore }
})

vi.mock('@synonymdev/pubky', () => {
  function Pubky() {
    return sdk.client
  }
  Pubky.testnet = vi.fn(() => sdk.client)

  return {
    AuthFlowKind: { signin: vi.fn(() => 'signin-kind') },
    Keypair: { random: vi.fn() },
    Pubky,
    PublicKey: { from: vi.fn((value) => value) },
  }
})

vi.mock('./config', () => ({
  APP_CAPABILITIES: '/pub/template/:rw',
  APP_CLIENT_ID: 'template',
  APP_NAME: 'Pubky App Template',
  HTTP_RELAY: 'https://relay.example',
  IS_TESTNET: false,
  STORAGE_NAMESPACE: undefined,
  TESTNET_HOST: undefined,
}))

import { restoreSavedSession, saveSession, startAuthFlow } from './pubky'

beforeEach(() => {
  vi.clearAllMocks()
  const values = new Map<string, string>()
  vi.stubGlobal('window', {
    location: new URL('https://app.example/basic/?ignored=value#fragment'),
    setTimeout,
  })
  vi.stubGlobal('localStorage', {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    removeItem: vi.fn((key: string) => values.delete(key)),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('startAuthFlow', () => {
  it('starts and polls grant authentication', async () => {
    const flow = await startAuthFlow('grant')

    expect(sdk.client.startGrantAuthFlow).toHaveBeenCalledWith('/pub/template/:rw', 'signin-kind', {
      clientId: 'template',
      relay: 'https://relay.example',
      xCallback: expectedCallbacks(flow.attemptId),
    })
    expect(sdk.client.startCookieAuthFlow).not.toHaveBeenCalled()
    await expect(flow.awaitApproval).resolves.toBe(sdk.grantSession)
    expect(sdk.grantFlow.free).toHaveBeenCalledOnce()
  })

  it('starts and polls cookie authentication', async () => {
    const flow = await startAuthFlow('cookie')

    expect(sdk.client.startCookieAuthFlow).toHaveBeenCalledWith(
      '/pub/template/:rw',
      'signin-kind',
      'https://relay.example',
      expectedCallbacks(flow.attemptId),
    )
    expect(sdk.client.startGrantAuthFlow).not.toHaveBeenCalled()
    await expect(flow.awaitApproval).resolves.toBe(sdk.cookieSession)
    expect(sdk.cookieFlow.free).toHaveBeenCalledOnce()
  })

  it('waits for an in-flight poll before freeing a canceled flow', async () => {
    let finishPoll: ((session: typeof sdk.grantSession) => void) | undefined
    sdk.grantFlow.tryPollOnce.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPoll = resolve
        }),
    )

    const flow = await startAuthFlow('grant')
    flow.cancel()
    expect(sdk.grantFlow.free).not.toHaveBeenCalled()

    expect(finishPoll).toBeTypeOf('function')
    finishPoll?.(sdk.grantSession)
    await expect(flow.awaitApproval).rejects.toMatchObject({ name: 'AuthCanceled' })
    expect(sdk.grantFlow.free).toHaveBeenCalledOnce()
  })
})

function expectedCallbacks(attemptId: string) {
  const base = `https://app.example/basic/?attempt=${attemptId}&outcome=`
  return {
    xSource: 'Pubky App Template',
    xSuccess: `${base}success`,
    xError: `${base}error`,
    xCancel: `${base}cancel`,
  }
}

describe('session persistence', () => {
  it('stores cookie metadata separately from the HTTP-only cookie', async () => {
    const cookie = {
      export: vi.fn(() => 'non-secret-cookie-metadata'),
      free: vi.fn(),
    }

    await saveSession({ cookie } as never)

    expect(JSON.parse(localStorage.getItem('template:session') ?? '')).toEqual({
      version: 1,
      kind: 'cookie',
      state: 'non-secret-cookie-metadata',
    })
    expect(cookie.free).toHaveBeenCalledOnce()

    const restored = { kind: 'restored-cookie-session' }
    sdk.client.restoreSession.mockResolvedValueOnce(restored)
    await expect(restoreSavedSession()).resolves.toBe(restored)
    expect(sdk.client.restoreSession).toHaveBeenCalledWith('non-secret-cookie-metadata')
  })

  it('stores and restores grant sessions through BrowserSessionStore', async () => {
    sdk.sessionStore.save.mockResolvedValueOnce({ id: 'public-key:grant-id' })
    await saveSession({ cookie: undefined } as never)

    expect(JSON.parse(localStorage.getItem('template:session') ?? '')).toEqual({
      version: 1,
      kind: 'grant',
      id: 'public-key:grant-id',
    })

    const restored = { kind: 'restored-grant-session' }
    sdk.sessionStore.restore.mockResolvedValueOnce(restored)
    await expect(restoreSavedSession()).resolves.toBe(restored)
    expect(sdk.sessionStore.restore).toHaveBeenCalledWith('public-key:grant-id')
    expect(sdk.sessionStore.free).toHaveBeenCalledTimes(2)
  })
})
