import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const PASSPORT = 'https://passport-v2.example'

async function mockPassport(context: BrowserContext, fallback = false) {
  await context.route(`${PASSPORT}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Test Passport</title>
      <h1>Create your account</h1>
      <button id="finish">Continue to sign in after creating the account in Ring</button>
      <button id="wrong-state">Send invalid state</button>
      <script>
        const params = new URLSearchParams(location.hash.slice(1));
        const callback = new URL(params.get('callback'));
        const state = params.get('state');
        function send(returnState) {
          if (window.opener && !${fallback}) {
            window.opener.postMessage({
              type: 'pubky-passport.signup-complete', version: 1,
              messageId: 'browser-test', state: returnState
            }, callback.origin);
          } else {
            callback.hash = new URLSearchParams({ signup: 'complete', state: returnState });
            location.replace(callback.href);
          }
        }
        document.querySelector('#finish').onclick = () => send(state);
        document.querySelector('#wrong-state').onclick = () => send('a-different-attempt');
      </script>`,
    }),
  )
}

async function mockSessions(context: BrowserContext) {
  // Keep real browser navigation, messaging and key validation; control only SDK approval.
  await context.route('**/src/pubky.ts', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
      const session = {
        info: { publicKey: { toString: () => 'pubky-browser-test-user' } },
        storage: { list: async () => [] }
      };
      function flow(kind) {
        const params = new URLSearchParams({ secret: crypto.randomUUID() });
        let reject, approve;
        const awaitApproval = new Promise((resolve, fail) => {
          reject = fail;
          approve = () => resolve(session);
          window.addEventListener('test-approve', approve, { once: true });
        });
        return {
          attemptId: crypto.randomUUID(),
          authorizationUrl: 'pubkyauth://' + kind + '?' + params,
          awaitApproval,
          cancel: () => {
            window.removeEventListener('test-approve', approve);
            reject(Object.assign(new Error('Canceled'), { name: 'AuthCanceled' }));
          }
        };
      }
      export const restoreSavedSession = async () => undefined;
      export const pubky = {};
      export const saveSession = async () => undefined;
      export const signOut = async () => undefined;
      export const signupDevelopmentUser = async () => session;
      export const startAuthFlow = async (method) => flow(method === 'grant' ? 'signin_grant' : 'signin');
      export const isAuthCanceled = (error) => error.name === 'AuthCanceled';
      export const isAuthExpired = (error) => error.name === 'AuthExpired';
    `,
    }),
  )
}

async function openDemo(page: Page) {
  await page.goto(`/?passport=${encodeURIComponent(PASSPORT)}`)
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeEnabled()
}

async function expectSignin(page: Page) {
  await expect(page.getByRole('link', { name: 'Open in Ring' })).toHaveAttribute(
    'href',
    /^pubkyauth:\/\/signin(_grant)?\?/,
  )
  await expect(page.getByLabel('Pubky Ring sign-in QR code')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue to sign in' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0)
  expect(new URL(page.url()).hash).toBe('')
}

test.describe('signup handoff', () => {
  test.beforeEach(async ({ context }) => {
    await mockSessions(context)
    await mockPassport(context)
  })

  test('popup completion starts sign-in and still requires Ring approval', async ({
    page,
  }, info) => {
    test.skip(info.project.name === 'mobile', 'Mobile defaults to same-tab navigation.')
    await openDemo(page)
    await page.getByLabel('Cookie', { exact: true }).check()
    const originalSignin = await page
      .getByRole('link', { name: 'Open in Ring' })
      .getAttribute('href')
    const opened = page.waitForEvent('popup')
    await page.getByRole('button', { name: 'Create account', exact: true }).click()
    const popup = await opened
    await popup.waitForLoadState()
    const entry = new URL(popup.url())
    expect([...new URLSearchParams(entry.hash.slice(1)).keys()].sort()).toEqual([
      'callback',
      'state',
    ])
    await popup.locator('#wrong-state').click()
    await expect(page.getByText('Continue in Passport', { exact: true })).toBeVisible()
    await popup.locator('#finish').click()
    await expectSignin(page)
    const ring = page.getByRole('link', { name: 'Open in Ring' })
    await expect(ring).toHaveAttribute('href', /^pubkyauth:\/\/signin\?/)
    const signinUrl = new URL((await ring.getAttribute('href'))!)
    expect(signinUrl.href).not.toBe(originalSignin)
    expect(signinUrl.searchParams.has('hs')).toBe(false)
    expect(signinUrl.searchParams.has('st')).toBe(false)
    await expect(page.getByLabel('Pubky Ring signup invite QR code')).toHaveCount(0)
    await expect(page.getByLabel('Pubky Ring sign-in QR code')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0)
    await page.evaluate(() => window.dispatchEvent(new Event('test-approve')))
    await expect(page.getByText('Signed in with Pubky.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible()
  })

  test('same-tab completion is scrubbed and starts sign-in', async ({ page }) => {
    await openDemo(page)
    await page.getByRole('button', { name: 'Create in this tab' }).click()
    await page.locator('#finish').click()
    await expectSignin(page)
    await expect(page.getByLabel('Custom Passport URL')).toHaveValue(PASSPORT)
    await page.getByRole('button', { name: 'Back to sign in' }).click()
    await expect(page.getByRole('link', { name: 'Open in Ring' })).toHaveAttribute(
      'href',
      /^pubkyauth:\/\/signin_grant\?/,
    )
    await expect(page.getByRole('button', { name: 'Create account', exact: true })).toBeEnabled()
  })

  test('fallback navigation in a popup returns completion to its opener', async ({
    page,
    context,
  }, info) => {
    test.skip(info.project.name === 'mobile', 'Mobile defaults to same-tab navigation.')
    await mockPassport(context, true)
    await openDemo(page)
    const opened = page.waitForEvent('popup')
    await page.getByRole('button', { name: 'Create account', exact: true }).click()
    const popup = await opened
    await popup.locator('#finish').click()
    await expectSignin(page)
    await expect.poll(() => popup.isClosed()).toBe(true)
  })

  test('blocked popups leave the same-tab option available', async ({ page }, info) => {
    test.skip(info.project.name === 'mobile', 'Mobile defaults to same-tab navigation.')
    await openDemo(page)
    await page.evaluate(() => {
      window.open = () => null
    })
    await page.getByRole('button', { name: 'Create account', exact: true }).click()
    await expect(page.getByText(/Passport popup was blocked/)).toBeVisible()
    await page.getByRole('button', { name: 'Create in this tab' }).click()
    await page.locator('#finish').click()
    await expectSignin(page)
  })

  test('unsolicited callback is scrubbed without starting signup', async ({ page }) => {
    await page.goto(
      `/#${new URLSearchParams({ signup: 'complete', state: 'not-an-active-attempt' })}`,
    )
    await expect(page.getByText(/expired or belongs to another tab/)).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open in Ring' })).toHaveAttribute(
      'href',
      /^pubkyauth:\/\/signin_grant\?/,
    )
    expect(new URL(page.url()).hash).toBe('')
  })

  test('mobile default opens Passport in the current tab', async ({ page }, info) => {
    test.skip(info.project.name !== 'mobile', 'Mobile-specific navigation.')
    await openDemo(page)
    await page.getByRole('button', { name: 'Create account', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`^${PASSPORT}/create-account`))
    await page.locator('#finish').click()
    await expectSignin(page)
    await expect(page.getByRole('link', { name: 'Open in Ring' })).toHaveAttribute(
      'href',
      /^pubkyauth:\/\/signin_grant\?/,
    )
    await page.evaluate(() => window.dispatchEvent(new Event('test-approve')))
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible()
  })
})

test('real SDK creates a fresh sign-in grant after Passport completion', async ({
  page,
  context,
}) => {
  await mockPassport(context)
  await context.route(/^https:\/\/(?!localhost:4173|passport-v2\.example)/, (route) => {
    // Keep the real SDK waiting for approval while inspecting its generated link.
    if (new URL(route.request().url()).hostname === 'httprelay.pubky.app') return
    return route.fulfill({ status: 404, body: '' })
  })
  await openDemo(page)
  await page.getByRole('button', { name: 'Create in this tab' }).click()
  await page.locator('#finish').click()
  await expectSignin(page)
  await expect(page.getByRole('link', { name: 'Open in Ring' })).toHaveAttribute(
    'href',
    /^pubkyauth:\/\/signin_grant\?/,
  )
  const url = new URL(
    (await page.getByRole('link', { name: 'Open in Ring' }).getAttribute('href'))!,
  )
  expect(url.searchParams.get('cid')).toBe('passport-v2-demo')
  expect(url.searchParams.get('caps')).toBe('/pub/passport-v2-demo/:rw')
  expect(url.searchParams.get('secret')).toBeTruthy()
  expect(url.searchParams.get('cpk')).toBeTruthy()
  expect(url.searchParams.has('hs')).toBe(false)
  expect(url.searchParams.has('st')).toBe(false)
})
