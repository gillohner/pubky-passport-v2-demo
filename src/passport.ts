import type { XCallbackParams } from '@synonymdev/pubky'
import { APP_CLIENT_ID, APP_NAME } from './config'

export const STAGING_PASSPORT_ORIGIN = 'https://passport.staging.pubky.app'
export const LOCAL_PASSPORT_ORIGIN = 'https://localhost:3000'

export type PassportLocation = 'staging' | 'local' | 'custom'
export type PassportOutcome = 'success' | 'error' | 'cancel'

export interface PassportSettings {
  location: PassportLocation
  customOrigin: string
}

export const DEFAULT_PASSPORT_SETTINGS: PassportSettings = {
  location: 'staging',
  customOrigin: '',
}

const OUTCOME_MESSAGE_TYPE = 'pubky-passport.authorization-outcome'
const ACKNOWLEDGEMENT_MESSAGE_TYPE = 'pubky-passport.authorization-outcome-ack'
const CALLBACK_MESSAGE_TYPE = 'basic-pubky-app.passport-return'
const MESSAGE_VERSION = 1
const CALLBACK_ATTEMPT_PARAMETER = 'attempt'
const CALLBACK_OUTCOME_PARAMETER = 'outcome'
const POPUP_CLOSE_GRACE_MS = 1_000
const ACKNOWLEDGEMENT_CACHE_MS = 3_000
const POPUP_ACK_CLOSE_DELAY_MS = ACKNOWLEDGEMENT_CACHE_MS + 100
const SETTINGS_KEY = `${APP_CLIENT_ID}:passport-settings`

interface AcknowledgedOutcome {
  popup: Window
  origin: string
  messageId: string
  outcome: PassportOutcome
}

let popup: Window | null | undefined
let popupOrigin: string | undefined
let popupCloseTimer: number | undefined
let popupCloseGraceTimer: number | undefined
let acknowledgedOutcome: AcknowledgedOutcome | undefined
let acknowledgementCacheTimer: number | undefined

export function readPassportSettings(): PassportSettings {
  const sharedOrigin = new URL(window.location.href).searchParams.get('passport')
  const configuredOrigin = sharedOrigin || import.meta.env.VITE_PASSPORT_ORIGIN
  if (configuredOrigin && normalizeCustomOrigin(configuredOrigin)) {
    const settings: PassportSettings = { location: 'custom', customOrigin: configuredOrigin }
    savePassportSettings(settings)
    return settings
  }
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null')
    if (
      isRecord(saved) &&
      typeof saved.customOrigin === 'string' &&
      (saved.location === 'staging' || saved.location === 'local' || saved.location === 'custom')
    ) {
      const settings: PassportSettings = {
        location: saved.location,
        customOrigin: saved.customOrigin,
      }
      if (passportOrigin(settings)) return settings
    }
  } catch {
    // An absent or malformed preference falls back to the staging deployment.
  }
  return { ...DEFAULT_PASSPORT_SETTINGS }
}

export function savePassportSettings(settings: PassportSettings) {
  if (passportOrigin(settings)) localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

export function passportOrigin(settings: PassportSettings): string | undefined {
  switch (settings.location) {
    case 'staging':
      return STAGING_PASSPORT_ORIGIN
    case 'local':
      return LOCAL_PASSPORT_ORIGIN
    case 'custom':
      return normalizeCustomOrigin(settings.customOrigin)
  }
}

/** HTTPS callbacks improve popup UX; the SDK relay remains authoritative for authentication. */
export function createPassportCallbacks(attemptId: string): XCallbackParams {
  const url = new URL(window.location.href)
  if (url.protocol !== 'https:') return { xSource: APP_NAME }

  return {
    xSource: APP_NAME,
    xSuccess: callbackUrl(url, attemptId, 'success'),
    xError: callbackUrl(url, attemptId, 'error'),
    xCancel: callbackUrl(url, attemptId, 'cancel'),
  }
}

export function createPassportAuthorizationUrl(
  pubkyAuthorizationUrl: string,
  settings: PassportSettings,
): string | undefined {
  const origin = passportOrigin(settings)
  if (!origin) return undefined
  return `${origin}/authorize#d=${encodeURIComponent(pubkyAuthorizationUrl)}`
}

export function openPassportPopup(authorizationUrl: string, onClose: () => void): boolean {
  const width = 520
  const height = 760
  const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2)
  const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2)

  closePassportPopup()
  popupOrigin = new URL(authorizationUrl).origin
  try {
    popup = window.open(
      authorizationUrl,
      `pubky-passport-${crypto.randomUUID()}`,
      `popup=yes,width=${width},height=${height},left=${left},top=${top}`,
    )
  } catch {
    popup = undefined
    popupOrigin = undefined
    return false
  }
  if (!popup) {
    popupOrigin = undefined
    return false
  }

  popup.focus()
  popupCloseTimer = window.setInterval(() => {
    if (!popup?.closed) return
    clearPopupCloseTimer()
    const closedPopup = popup
    popupCloseGraceTimer = window.setTimeout(() => {
      popupCloseGraceTimer = undefined
      if (popup !== closedPopup) return
      popup = undefined
      popupOrigin = undefined
      onClose()
    }, POPUP_CLOSE_GRACE_MS)
  }, 500)
  return true
}

export function takePassportOutcome(
  event: MessageEvent,
  expectedAttemptId: string | undefined,
): PassportOutcome | undefined {
  if (acknowledgeDuplicateOutcome(event)) return undefined

  const message = parseOutcomeMessage(event)
  if (message && popup && popupOrigin) {
    const activePopup = popup
    const activeOrigin = popupOrigin
    acknowledgeOutcome(activePopup, activeOrigin, message.messageId)
    cacheAcknowledgedOutcome(activePopup, activeOrigin, message)
    popup = undefined
    popupOrigin = undefined
    clearPopupCloseTimer()
    clearPopupCloseGraceTimer()
    window.setTimeout(() => closePopupWindow(activePopup), POPUP_ACK_CLOSE_DELAY_MS)
    return message.outcome
  }

  const callbackOutcome = parseCallbackOutcomeMessage(event, expectedAttemptId)
  if (!callbackOutcome) return undefined
  closePassportPopup()
  return callbackOutcome
}

export function closePassportPopup() {
  const activePopup = popup
  popup = undefined
  popupOrigin = undefined
  clearPopupCloseTimer()
  clearPopupCloseGraceTimer()

  if (activePopup) closePopupWindow(activePopup)
}

/** Reads and removes a callback navigation hint; it never establishes authentication. */
export function readCallbackOutcome(): PassportOutcome | undefined {
  const url = new URL(window.location.href)
  const attemptId = url.searchParams.get(CALLBACK_ATTEMPT_PARAMETER)
  const outcome = parseOutcome(url.searchParams.get(CALLBACK_OUTCOME_PARAMETER))
  const hasCallbackParameters =
    url.searchParams.has(CALLBACK_ATTEMPT_PARAMETER) ||
    url.searchParams.has(CALLBACK_OUTCOME_PARAMETER)
  if (!hasCallbackParameters) return undefined

  url.searchParams.delete(CALLBACK_ATTEMPT_PARAMETER)
  url.searchParams.delete(CALLBACK_OUTCOME_PARAMETER)
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  if (!attemptId || !outcome) return undefined

  if (window.opener && !window.opener.closed) {
    window.opener.postMessage(
      { type: CALLBACK_MESSAGE_TYPE, attemptId, outcome },
      window.location.origin,
    )
    window.close()
    return outcome
  }

  return undefined
}

function clearPopupCloseTimer() {
  if (popupCloseTimer === undefined) return
  window.clearInterval(popupCloseTimer)
  popupCloseTimer = undefined
}

function clearPopupCloseGraceTimer() {
  if (popupCloseGraceTimer === undefined) return
  window.clearTimeout(popupCloseGraceTimer)
  popupCloseGraceTimer = undefined
}

function acknowledgeDuplicateOutcome(event: MessageEvent) {
  const acknowledged = acknowledgedOutcome
  if (
    !acknowledged ||
    event.origin !== acknowledged.origin ||
    event.source !== acknowledged.popup
  ) {
    return false
  }
  if (!isRecord(event.data)) return false

  const outcome = parseOutcome(event.data.outcome)
  if (
    event.data.type !== OUTCOME_MESSAGE_TYPE ||
    event.data.version !== MESSAGE_VERSION ||
    event.data.messageId !== acknowledged.messageId ||
    outcome !== acknowledged.outcome
  ) {
    return false
  }

  acknowledgeOutcome(acknowledged.popup, acknowledged.origin, acknowledged.messageId)
  return true
}

function cacheAcknowledgedOutcome(
  activePopup: Window,
  origin: string,
  message: { outcome: PassportOutcome; messageId: string },
) {
  if (acknowledgementCacheTimer !== undefined) {
    window.clearTimeout(acknowledgementCacheTimer)
  }

  acknowledgedOutcome = { popup: activePopup, origin, ...message }
  acknowledgementCacheTimer = window.setTimeout(() => {
    acknowledgedOutcome = undefined
    acknowledgementCacheTimer = undefined
  }, ACKNOWLEDGEMENT_CACHE_MS)
}

function acknowledgeOutcome(activePopup: Window, origin: string, messageId: string) {
  activePopup.postMessage(
    {
      type: ACKNOWLEDGEMENT_MESSAGE_TYPE,
      version: MESSAGE_VERSION,
      messageId,
    },
    origin,
  )
}

function closePopupWindow(activePopup: Window) {
  try {
    if (!activePopup.closed) activePopup.close()
  } catch {
    // Popup cleanup is best effort when the cross-origin window is unavailable.
  }
}

function parseOutcomeMessage(event: MessageEvent) {
  if (event.origin !== popupOrigin || !popup || event.source !== popup) return undefined
  if (!isRecord(event.data)) return undefined

  const outcome = parseOutcome(event.data.outcome)
  if (
    event.data.type !== OUTCOME_MESSAGE_TYPE ||
    event.data.version !== MESSAGE_VERSION ||
    !outcome ||
    typeof event.data.messageId !== 'string' ||
    event.data.messageId.length === 0
  ) {
    return undefined
  }

  return { outcome, messageId: event.data.messageId }
}

function parseCallbackOutcomeMessage(
  event: MessageEvent,
  expectedAttemptId: string | undefined,
): PassportOutcome | undefined {
  if (
    !popup ||
    event.source !== popup ||
    event.origin !== window.location.origin ||
    !expectedAttemptId ||
    !isRecord(event.data) ||
    event.data.type !== CALLBACK_MESSAGE_TYPE ||
    event.data.attemptId !== expectedAttemptId
  ) {
    return undefined
  }

  return parseOutcome(event.data.outcome)
}

function callbackUrl(baseUrl: URL, attemptId: string, outcome: PassportOutcome) {
  const url = new URL(baseUrl)
  url.search = ''
  url.hash = ''
  url.searchParams.set(CALLBACK_ATTEMPT_PARAMETER, attemptId)
  url.searchParams.set(CALLBACK_OUTCOME_PARAMETER, outcome)
  return url.href
}

function normalizeCustomOrigin(value: string): string | undefined {
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' || url.username || url.password) return undefined
    return url.origin
  } catch {
    return undefined
  }
}

function parseOutcome(value: unknown): PassportOutcome | undefined {
  return value === 'success' || value === 'error' || value === 'cancel' ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
