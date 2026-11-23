declare module 'snowflake-sdk/dist/lib/http/stillmark_deadline' {
  export function runWithSignal<T>(signal: AbortSignal, work: () => T): T
}
