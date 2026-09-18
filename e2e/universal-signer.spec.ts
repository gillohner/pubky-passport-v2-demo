import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const PASSPORT = 'https://passport-v2.example'

async function mockPassport(context: BrowserContext) {
  await context.route(`${PASSPORT}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Test Passport</title>
        <h1>Passport universal signer</h1>
        <p id="request"></p>
        <button id="report-success">Report local approval</button>
        <script>
          const request = new URLSearchParams(location.hash.slice(1)).get('d');
          document.querySelector('#request').textContent = request;
          document.querySelector('#report-success').onclick = () => {
            window.opener.postMessage({
              type: 'pubky-passport.authorization-outcome',
              version: 1,
              outcome: 'success',
              messageId: 'browser-test'
            }, '*');
          };
        </script>`,
    }),
  )
}

async function mockSessions(context: BrowserContext) {
  // Keep real browser navigation and messaging; control only SDK approval.
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
  await expect(
    page.getByRole('button', { name: 'Create account in Passport', exact: true }),
  ).toBeEnabled()
}

async function ringAuthorizationUrl(page: Page) {
  const value = await page.getByRole('link', { name: 'Open in Ring' }).getAttribute('href')
  expect(value).toMatch(/^pubkyauth:\/\/signin(_grant)?\?/u)
  return value!
}

async function expectSamePassportRequest(popup: Page, authorizationUrl: string) {
  await popup.waitForLoadState()
  const entry = new URL(popup.url())
  const params = new URLSearchParams(entry.hash.slice(1))
  expect(entry.origin + entry.pathname).toBe(`${PASSPORT}/`)
  expect([...params.keys()]).toEqual(['d'])
  expect(params.get('d')).toBe(authorizationUrl)
  await expect(popup.locator('#request')).toHaveText(authorizationUrl)
}

test.describe('Passport universal signer handoff', () => {
  test.beforeEach(async ({ context }) => {
    await mockSessions(context)
    await mockPassport(context)
  })

  test('account creation keeps the original SDK request through approval', async ({ page }) => {
    await openDemo(page)
    const authorizationUrl = await ringAuthorizationUrl(page)
    const opened = page.waitForEvent('popup')
    await page.getByRole('button', { name: 'Create account in Passport' }).click()
    const popup = await opened

    await expectSamePassportRequest(popup, authorizationUrl)
    expect(await ringAuthorizationUrl(page)).toBe(authorizationUrl)
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0)

    await page.evaluate(() => window.dispatchEvent(new Event('test-approve')))
    await expect(page.getByText('Signed in with Pubky.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible()
    await expect.poll(() => popup.isClosed()).toBe(true)
  })

  test('Passport success remains advisory until SDK approval', async ({ page }) => {
    await openDemo(page)
    const opened = page.waitForEvent('popup')
    await page.getByRole('button', { name: 'Sign in with Passport' }).click()
    const popup = await opened
    await popup.locator('#report-success').click()

    await expect(
      page.getByText('Passport reported success. Waiting for verified Pubky relay approval...'),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0)
    expect(popup.isClosed()).toBe(false)

    await page.evaluate(() => window.dispatchEvent(new Event('test-approve')))
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible()
    await expect.poll(() => popup.isClosed()).toBe(true)
  })

  test('closing Passport leaves the original request available', async ({ page }) => {
    await openDemo(page)
    const authorizationUrl = await ringAuthorizationUrl(page)
    const opened = page.waitForEvent('popup')
    await page.getByRole('button', { name: 'Create account in Passport' }).click()
    const popup = await opened
    await popup.close()

    await expect(page.getByText(/original request is still active/u)).toBeVisible()
    expect(await ringAuthorizationUrl(page)).toBe(authorizationUrl)
    await expect(
      page.getByRole('button', { name: 'Create account in Passport', exact: true }),
    ).toBeEnabled()
  })

  test('a blocked popup does not replace the request', async ({ page }) => {
    await openDemo(page)
    const authorizationUrl = await ringAuthorizationUrl(page)
    await page.evaluate(() => {
      window.open = () => null
    })
    await page.getByRole('button', { name: 'Create account in Passport' }).click()

    await expect(page.getByText(/Passport popup was blocked/u)).toBeVisible()
    expect(await ringAuthorizationUrl(page)).toBe(authorizationUrl)
  })
})
