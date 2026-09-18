# Pubky Passport v2 Demo

A separate mainnet client for testing Passport v2, based on the
[basic Pubky app template](https://github.com/gillohner/pubky-app-templates/tree/main/basic-pubky-app).
It preserves Ring and Passport sign-in, grant/cookie selection, saved sessions,
file editing, and the event stream. The Passport integration demonstrates the
unified signer and account-creation flow.

**[Open the demo](https://gillohner.github.io/pubky-passport-v2-demo/)**

## Test with a Passport deployment

1. Set **Passport URL** to **Custom URL** and enter the HTTPS origin of the v2
   deployment, such as `https://passport-v2.example.com`. The setting is remembered.
   The default is `https://passport.staging.pubky.app`; the selected deployment
   must provide Passport's unified signer at `/`.
2. Select **Create account in Passport**. The demo opens Passport with the same
   authorization request already displayed for Ring.
3. In Passport, choose **Create an account**, then SMS, Lightning, or a manual
   invite. Continue with Ring or keep the new identity in Passport. Google and
   backup import are available from the same signer chooser.
4. Finish setup and explicitly approve the demo's original permission request.
   The demo keeps waiting on that SDK flow and does not create a replacement.
5. Only verified SDK approval opens the file editor. Save a file to check the
   complete flow.

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

The demo creates one authorization flow with the Pubky SDK and opens Passport at
`/#d=${encodeURIComponent(flow.authorizationUrl)}`. The exact request is reused
whether the user selects a saved identity, Google, backup import, Ring, another
signer, or creates an account. The URL remains in memory and is never written to
persistent client storage.

Passport may send the existing, origin- and window-bound authorization outcome
messages for local approval UX. A success message remains advisory: the demo
keeps waiting for its SDK session and closes the popup only when SDK approval
succeeds. Closing or blocking Passport does not cancel or replace the request.

Passport owns identity setup, invites, signup QR/deeplinks, backup verification,
and local registration. The old `/create-account` route and separate
`pubky-passport.signup-complete` callback protocol are not used.

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
| `VITE_PUBKY_HTTP_RELAY`        | Custom relay for sign-in                                         |
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
and duplicate acknowledgements. Browser tests verify that desktop and mobile
hand the exact request to Passport's root route, retain it across popup closure,
and wait for SDK approval even after a Passport success message. Tests mock
Passport and relay approval; they send no SMS and pay no invoices. Live Homegate
verification and Ring interoperability require manual testing against your v2
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
