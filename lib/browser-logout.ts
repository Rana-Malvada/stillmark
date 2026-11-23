import { clientOperation } from './client-operation'

/** Snowflake ends the ingress session and returns JSON, not a signed-out HTML page. */
export async function endGallerySession() {
  await clientOperation(
    '/sfc-endpoint/logout',
    {
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { Accept: 'application/json' },
    },
    'Logout was not confirmed. Please try again.',
    (value): value is { responseType: 'SUCCESS_RESPOND_TO_CUSTOMER' } =>
      !!value &&
      typeof value === 'object' &&
      'responseType' in value &&
      value.responseType === 'SUCCESS_RESPOND_TO_CUSTOMER',
    15_000,
  )
}
