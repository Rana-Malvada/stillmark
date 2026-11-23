import { expect, it } from 'vitest'
import { uploadFailureDiagnostic } from '@/lib/diagnostic-schema'

it('drops untrusted identifiers, phase names, custom messages and error names', () => {
  const result = uploadFailureDiagnostic(
    { name: 'private.jpg', message: 'private SQL', code: 'secret-password' },
    { uploadId: 'private customer name', attempt: NaN, phase: 'secret' as never, retry: true },
  )
  expect(result).toEqual({
    event: 'upload-processing-failed',
    uploadId: undefined,
    attempt: undefined,
    phase: undefined,
    code: 'OTHER',
    retry: true,
  })
})
it('retains safe SQLSTATE codes without the SQL or parameter values', () => {
  expect(
    uploadFailureDiagnostic(
      { code: '23505', detail: 'private data' },
      { uploadId: 'not-a-uuid', attempt: 2, phase: 'complete', retry: false },
    ),
  ).toMatchObject({ code: '23505', attempt: 2, retry: false, phase: 'complete' })
})
