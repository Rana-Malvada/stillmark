/**
 * Server-side log lines in the house format.
 *
 * A text message becomes one `[scope] message` string, followed by any details.
 * Anything else (an Error, a data object) is passed after a bare `[scope]` tag.
 * The two shapes are deliberate: production diagnostics classify a line by a
 * bare `[scope]` argument (see `safeDiagnostic`), so the helper must hand
 * `console` exactly the arguments the call sites passed before it existed.
 *
 * Never pass secrets, passwords or personal data.
 */
function line(scope: string, message: unknown, details: unknown[]): unknown[] {
  return typeof message === 'string'
    ? [`[${scope}] ${message}`, ...details]
    : [`[${scope}]`, message, ...details]
}

export function logInfo(scope: string, message: unknown, ...details: unknown[]): void {
  console.log(...line(scope, message, details))
}

export function logWarn(scope: string, message: unknown, ...details: unknown[]): void {
  console.warn(...line(scope, message, details))
}

export function logError(scope: string, message: unknown, ...details: unknown[]): void {
  console.error(...line(scope, message, details))
}
