import { toCanvas } from 'qrcode'
import { DEVELOPMENT_SIGNUP_HOMESERVER, SHOW_DEVELOPMENT_SIGNUP } from './config'
import { disabledAttr, escapeHtml } from './html'
import {
  LOCAL_PASSPORT_ORIGIN,
  STAGING_PASSPORT_ORIGIN,
  passportOrigin,
  type PassportSettings,
} from './passport'
import type { AuthMethod } from './pubky'

export interface SigninState {
  authorizationUrl?: string
  ringCopied?: boolean
  passportCopied?: boolean
  expired?: boolean
  loading?: boolean
  token?: symbol
}

export type AuthorizationUrlKind = 'ring' | 'passport'

const RING_QR_SIZE = 220
const AUTHORIZE_RING_LINK_ID = 'authorize-ring'
const COPY_RING_URL_ID = 'copy-ring-authorization-url'
const COPY_PASSPORT_URL_ID = 'copy-passport-authorization-url'
const COPY_LINK_LABEL = 'Copy link'

export function authViewHtml(
  signin: SigninState,
  busy: string | undefined,
  passport: PassportSettings,
  authMethod: AuthMethod,
) {
  const cardCount = 2 + Number(SHOW_DEVELOPMENT_SIGNUP)
  return `
    <section id="signin-view" class="auth-grid ${cardCount === 1 ? 'single-card' : ''}">
      ${authCardsHtml(signin, busy, passport, authMethod)}
    </section>
  `
}

export function updateSigninView(
  signin: SigninState,
  busy: string | undefined,
  passport: PassportSettings,
  authMethod: AuthMethod,
) {
  const view = document.querySelector('#signin-view')
  if (!view) return
  view.innerHTML = authCardsHtml(signin, busy, passport, authMethod)
  void renderRingSigninQr(signin)
}

export function updateCopyButton(kind: AuthorizationUrlKind, copied: boolean) {
  const id = kind === 'ring' ? COPY_RING_URL_ID : COPY_PASSPORT_URL_ID
  const button = document.querySelector(`#${id}`)
  if (button) button.textContent = copied ? 'Copied' : COPY_LINK_LABEL
}

export function updateAuthorizeLink(canUse: boolean, authorizationUrl?: string) {
  const link = document.querySelector<HTMLAnchorElement>(`#${AUTHORIZE_RING_LINK_ID}`)
  if (!link) return

  if (canUse && authorizationUrl) {
    link.href = authorizationUrl
    link.removeAttribute('aria-disabled')
    return
  }

  link.removeAttribute('href')
  link.setAttribute('aria-disabled', 'true')
}

export function isAuthorizeRingLink(element: Element) {
  return Boolean(element.closest(`#${AUTHORIZE_RING_LINK_ID}`))
}

export async function renderRingSigninQr(signin: SigninState) {
  const canvas = document.querySelector<HTMLCanvasElement>('#ring-signin-qr')
  // Ring scans the raw Pubky link, never Passport's /#d wrapper.
  const ringAuthorizationUrl = signin.authorizationUrl
  if (!canvas || !ringAuthorizationUrl || signin.expired) return

  try {
    await toCanvas(canvas, ringAuthorizationUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: RING_QR_SIZE,
      color: {
        dark: '#101828',
        light: '#ffffff',
      },
    })
  } catch {
    console.error('Failed to render Pubky Ring QR code')
  }
}

function authCardsHtml(
  signin: SigninState,
  busy: string | undefined,
  passport: PassportSettings,
  authMethod: AuthMethod,
) {
  return `
    ${ringCardHtml(signin, busy)}
    ${passportCardHtml(signin, passport, authMethod, busy)}
    ${SHOW_DEVELOPMENT_SIGNUP ? newIdentityCardHtml(busy) : ''}
  `
}

function ringCardHtml(signin: SigninState, busy?: string) {
  const { authorizationUrl, expired, loading, ringCopied } = signin
  const canUse = !busy && Boolean(authorizationUrl) && !loading && !expired
  const title = 'Sign in with Pubky Ring'

  return `
    <section id="ring-signin-card" class="panel auth-card">
      <div class="section-header">
        <h2>${title}</h2>
        <button id="refresh-ring-signin" type="button" ${disabledAttr(Boolean(busy) || Boolean(loading))}>
          ${expired ? 'New link' : 'Refresh'}
        </button>
      </div>
      <div class="ring-signin">
        <div class="qr-frame">
          ${ringQrSlot(signin)}
        </div>
        <div class="ring-actions">
          ${authorizeRingLinkHtml(canUse, authorizationUrl)}
          <button id="${COPY_RING_URL_ID}" type="button" ${disabledAttr(!canUse)}>
            ${ringCopied ? 'Copied' : COPY_LINK_LABEL}
          </button>
        </div>

      </div>
    </section>
  `
}

function passportCardHtml(
  signin: SigninState,
  passport: PassportSettings,
  authMethod: AuthMethod,
  busy?: string,
) {
  const { authorizationUrl, expired, loading, passportCopied } = signin
  const customOrigin = passport.location === 'custom' ? passportOrigin(passport) : undefined
  const customInvalid = passport.location === 'custom' && !customOrigin
  const canUse =
    !busy && Boolean(authorizationUrl) && !loading && !expired && Boolean(passportOrigin(passport))

  return `
    <section id="passport-signin-card" class="panel auth-card">
      <div class="section-header">
        <h2>Pubky Passport</h2>
      </div>
      <div class="passport-signin">
        <div class="passport-options">
          <label>
            Passport URL
            <select id="passport-location">
              <option value="staging" ${selectedAttr(passport.location === 'staging')}>
                ${STAGING_PASSPORT_ORIGIN}
              </option>
              <option value="local" ${selectedAttr(passport.location === 'local')}>
                ${LOCAL_PASSPORT_ORIGIN}
              </option>
              <option value="custom" ${selectedAttr(passport.location === 'custom')}>
                Custom URL
              </option>
            </select>
          </label>
          ${
            passport.location === 'custom'
              ? `
                <label>
                  Custom Passport URL
                  <input
                    id="custom-passport-origin"
                    type="url"
                    inputmode="url"
                    autocomplete="url"
                    placeholder="https://passport.example.com"
                    value="${escapeHtml(passport.customOrigin)}"
                    aria-invalid="${customInvalid}"
                    aria-describedby="custom-passport-origin-help"
                  />
                </label>
                <p
                  id="custom-passport-origin-help"
                  class="${customInvalid ? 'field-error' : 'muted'}"
                >
                  Custom Passport URLs must use HTTPS.
                </p>
              `
              : ''
          }
          <fieldset class="auth-method-switch">
            <legend>Sign-in authentication</legend>
            <label>
              <input
                type="radio"
                name="auth-method"
                value="grant"
                ${checkedAttr(authMethod === 'grant')}
              />
              Grant
            </label>
            <label>
              <input
                type="radio"
                name="auth-method"
                value="cookie"
                ${checkedAttr(authMethod === 'cookie')}
              />
              Cookie
            </label>
          </fieldset>
          <p class="muted">Changing authentication creates a fresh Pubky authorization link.</p>
        </div>
        <div class="create-account-options">
          <h3>Create account</h3>
          <p class="muted">Passport uses this same authorization request while you create an account with SMS, Lightning, a manual invite, or Google. After setup, approve this demo without starting over.</p>
          <div class="passport-actions">
            <button id="create-account" class="primary" type="button" ${disabledAttr(!canUse)}>Create account in Passport</button>
          </div>
        </div>
        <div class="passport-actions">
          <button id="open-passport" class="primary" type="button" ${disabledAttr(!canUse)}>
            Sign in with Passport
          </button>
          <button id="${COPY_PASSPORT_URL_ID}" type="button" ${disabledAttr(!canUse)}>
            ${passportCopied ? 'Copied' : COPY_LINK_LABEL}
          </button>
        </div>
      </div>
    </section>
  `
}

function selectedAttr(selected: boolean) {
  return selected ? 'selected' : ''
}

function checkedAttr(checked: boolean) {
  return checked ? 'checked' : ''
}

function authorizeRingLinkHtml(canUse: boolean, authorizationUrl: string | undefined) {
  if (canUse && authorizationUrl) {
    return `<a id="${AUTHORIZE_RING_LINK_ID}" class="button-link primary" href="${escapeHtml(authorizationUrl)}">Open in Ring</a>`
  }

  return `<a id="${AUTHORIZE_RING_LINK_ID}" class="button-link primary" aria-disabled="true">Open in Ring</a>`
}

function ringQrSlot(signin: SigninState) {
  const { authorizationUrl, expired, loading } = signin

  if (loading) {
    return ringQrPlaceholder(`
      <span class="spinner" aria-hidden="true"></span>
      <span>Generating link...</span>
    `)
  }

  if (expired) {
    return ringQrPlaceholder(`
      <strong>Link expired</strong>
      <span>Generate a fresh one.</span>
    `)
  }

  if (!authorizationUrl) return ringQrPlaceholder('<span>Waiting for Ring link...</span>')

  return `
    <canvas
      id="ring-signin-qr"
      class="ring-qr"
      width="${RING_QR_SIZE}"
      height="${RING_QR_SIZE}"
      aria-label="Pubky Ring sign-in QR code"
    ></canvas>
  `
}

function ringQrPlaceholder(content: string) {
  return `<div class="qr-placeholder" aria-live="polite">${content}</div>`
}

function newIdentityCardHtml(busy?: string) {
  return `
    <section class="panel auth-card">
      <h2>New identity</h2>
      <p class="muted">
        Create a new keypair, sign up and sign in on the homeserver, in one go.
        Primarily for development, to move through auth quickly.
      </p>
      <p class="muted">
        Requires the homeserver to run with signup_mode = "open". If signup is closed or
        token-required, this shortcut will fail; use Pubky Ring instead.
      </p>
      <form id="development-signup-form" class="form-grid">
        <label>
          Homeserver public key
          <input
            name="homeserver"
            autocomplete="off"
            value="${escapeHtml(DEVELOPMENT_SIGNUP_HOMESERVER)}"
            required
          />
        </label>
        <button type="submit" ${disabledAttr(Boolean(busy))}>Create identity and sign in</button>
      </form>
    </section>
  `
}
