# Pubky Passport v2 Demo

A separate mainnet client for testing Passport v2, based on the
[basic Pubky app template](https://github.com/gillohner/pubky-app-templates/tree/main/basic-pubky-app).
It preserves Ring and Passport sign-in, grant/cookie selection, saved sessions,
file editing, and the event stream. Account creation adds the client side of
[Passport #160](https://github.com/pubky/pubky-passport/issues/160) and
[Passport PR #162](https://github.com/pubky/pubky-passport/pull/162).

**[Open the demo](https://gillohner.github.io/pubky-passport-v2-demo/)**

## Test with a Passport deployment

1. Set **Passport URL** to **Custom URL** and enter the HTTPS origin of the v2
   deployment, such as `https://passport-v2.example.com`. The setting is remembered.
   The default is `https://passport.staging.pubky.app`; the selected deployment
   must include the `/create-account` route from PR #162.
2. Select **Create account**, then SMS or Lightning in Passport. Desktop opens a
   popup; mobile uses the current tab. **Create in this tab** explicitly tests the
   navigation callback on any device.
3. Finish verification in Passport. The demo receives the homeserver invite and
   displays a new **Ring signup QR** and **Open in Ring** link. On mobile it also
   attempts to open Ring automatically; tap the link if the browser blocks that.
4. Finish account creation and authorization in Ring, then return to the demo.
   The file editor appears only after the SDK returns an authenticated session.
   Save a file to check the complete flow.

For Google, Passport creates its cloud account using the existing Google flow.
Return to the demo and choose **Sign in with Passport** afterward. Google does
not return a Ring invite.

You can share a deployment selection with a link:

```text
https://gillohner.github.io/pubky-passport-v2-demo/?passport=https%3A%2F%2Fpassport-v2.example.com
```

The client ID and capability are `passport-v2-demo` and
`/pub/passport-v2-demo/:rw`. This keeps its files and saved-session reference
separate from the original template. All projects on the same GitHub Pages
hostname share a browser origin; this is an integration demo, not an origin
isolation boundary.

## Handoff contract

`src/signup.ts` sends only a callback and fresh state to
`/create-account#callback=…&state=…`. No authorization URL, relay secret, or client
key is given to Passport on this path. Attempts expire after 30 minutes.

For popup messages, the demo validates the exact Passport origin, popup window,
message type/version, state, canonical homeserver key, and bounded token. It
retains the invite and consumes the pending state before acknowledging, and
deduplicates retries. A popup that navigates back instead forwards the invite to
its opener using the same state and window checks.

For a same-tab callback, it captures and removes `#hs=…&st=…&state=…` before
rendering, checks the pending state in session storage, and consumes it once.
Invalid, unsolicited, expired, and replayed callbacks cannot start signup.

`src/pubky.ts` uses the returned invite with `AuthFlowKind.signup` and
`startGrantAuthFlow`. The client owns the resulting `signup_grant` QR, deeplink,
and relay secret. An invite or Passport success message cannot establish a
session; only SDK approval can. Account creation always uses grants even if
cookie sign-in was selected. Pending flows are canceled when abandoned and freed
after polling stops. Reloading while waiting for Ring abandons that pending
flow; if Ring has already created the account, use the normal sign-in flow.

## Local development

Use Node.js 22.12 or later:

```sh
npm ci
npm run dev:https
```

Open the printed HTTPS URL and accept the local development certificate. Passport
requires HTTPS callbacks, including on localhost. Keep the same hostname when
returning to the demo. For a local Passport, select `https://localhost:3000` and
accept its certificate as well. Phone testing needs an HTTPS URL reachable by
the phone, such as the hosted demo or your own tunnel.

`npm run dev` remains available for HTTP sign-in-only development.

Optional Vite environment variables:

| Variable                       | Purpose                                                          |
| ------------------------------ | ---------------------------------------------------------------- |
| `VITE_PASSPORT_ORIGIN`         | Default Passport origin; the `?passport=` parameter overrides it |
| `VITE_PUBKY_HTTP_RELAY`        | Custom relay for sign-in and signup                              |
| `VITE_PUBKY_TESTNET=true`      | Use the SDK's testnet configuration                              |
| `VITE_PUBKY_TESTNET_HOST`      | Optional testnet host                                            |
| `VITE_PUBKY_STORAGE_NAMESPACE` | Extra prefix for saved-session references                        |

The hosted build uses mainnet. For testnet, also point Passport/Homegate at the
matching homeserver and Ring at the matching network.

## Checks and deployment

```sh
npm run check
npx playwright install --with-deps chromium firefox webkit
npm run test:e2e
npm run audit
```

Unit tests cover SDK flow selection, session persistence, callback validation,
replays, expiry, and duplicate acknowledgements. Browser tests cover popup and
same-tab returns, fallback navigation, blocked popups, mobile navigation, and
the distinction between receiving an invite and approving a session. A separate
browser test uses the real SDK to construct the signup grant. Tests mock Passport
verification and relay traffic; they send no SMS and pay no invoices. Live
Homegate verification and Ring approval require manual testing against your v2
deployment.

The GitHub Actions workflow checks, builds, runs the browser suite, and deploys
successful `main` builds to GitHub Pages. Enable Pages with **GitHub Actions** as
the source when copying this repository.

## Origin and license

Derived from `basic-pubky-app` at
[`gillohner/pubky-app-templates@0431049`](https://github.com/gillohner/pubky-app-templates/commit/04310496ce26249e8ceb9ff6a8f74ca9edf8f159),
originally from [pubky/pubky-app-templates](https://github.com/pubky/pubky-app-templates).
Published as a standalone repository so this experiment has its own deployment.
The original MIT [LICENSE](LICENSE) is retained.
