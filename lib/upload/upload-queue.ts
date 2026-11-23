import { isUploadMetadata } from './upload-file-filter'
import { type FileProgress, isUploadResult, type UploadResult } from '@/lib/upload/upload-response'
import { checkUploadJobs, retryQueuedUpload, uploadFile } from '@/lib/upload/upload-client'
import {
  fileIdentity,
  type FileIdentity,
  type SavedUpload,
  type UploadStorage,
} from './upload-storage'

export interface UploadBatch {
  id: string
  label: string
  eventId?: number
  accessIssue?: 'authentication' | 'permission' | 'upstream'
  cancelling?: boolean
  running: boolean
  files: FileProgress[]
  recovered?: boolean
  warning?: string
  needsFiles?: boolean
}
export function isBatchUploading(batch: UploadBatch) {
  return (
    batch.running &&
    batch.files.some((f) => ['waiting', 'uploading', 'processing'].includes(f.phase))
  )
}
async function storageWait<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    signal?.throwIfAborted()
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Browser storage timed out')), 5000)
        abort = () => reject(signal?.reason)
        signal?.addEventListener('abort', abort, { once: true })
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
  }
}
type Work = {
  identities?: FileIdentity[]
  id: string
  files: (File | null)[]
  fields: Record<string, unknown>
  uploadIds: string[]
  frozen: (Record<string, unknown> | null)[]
  controller: AbortController
  persisted: boolean
}
export class UploadQueue {
  private batches: UploadBatch[] = []
  private work = new Map<string, Work>()
  private listeners = new Set<() => void>()
  private activeBatch?: string
  private active?: AbortController
  private monitors = new Map<string, { timer?: ReturnType<typeof setTimeout> }>()
  private lifetime?: AbortController
  private authenticationPaused = false
  private accessIssue: UploadBatch['accessIssue']
  private ready: Promise<void> = Promise.resolve()
  constructor(
    private send = uploadFile,
    private completed: (eventId: number) => void = () => {},
    private storage?: UploadStorage,
  ) {}
  /** Construction is safe during a replayed React render. Only a committed
   * provider (or an explicit upload action) activates storage and monitoring. */
  activate() {
    if (!this.lifetime || this.lifetime.signal.aborted) {
      this.lifetime = new AbortController()
      // Effect reactivation can reuse this queue. Keep accepted jobs monitored,
      // but require an explicit retry for browser transfers that were interrupted.
      this.batches = this.batches.map((batch) =>
        this.work.get(batch.id)?.controller.signal.aborted
          ? {
              ...batch,
              cancelling: false,
              running: batch.files.some((f) => f.serverQueued && f.phase === 'processing'),
              files: batch.files.map((f) =>
                !f.serverQueued && ['waiting', 'uploading', 'processing'].includes(f.phase)
                  ? {
                      ...f,
                      phase: 'failed' as const,
                      error: 'Interrupted upload. Resume to continue.',
                    }
                  : f,
              ),
            }
          : batch,
      )
      this.activeBatch = undefined
      this.ready = this.restore(this.lifetime.signal)
      for (const batch of this.batches)
        if (batch.files.some((f) => f.serverQueued && f.phase === 'processing'))
          this.monitor(batch.id)
      if (this.batches.length) this.emit()
    }
    const lifetime = this.lifetime
    return () => {
      if (this.lifetime !== lifetime || lifetime.signal.aborted) return
      lifetime.abort(new DOMException('Upload view closed', 'AbortError'))
      for (const monitor of this.monitors.values()) clearTimeout(monitor.timer)
      this.monitors.clear()
      // This only stops browser requests. Accepted durable jobs and stable IDs
      // remain available for the next provider's authorized recovery.
      for (const work of this.work.values()) work.controller.abort(lifetime.signal.reason)
    }
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  snapshot = () => this.batches
  private emit() {
    for (const listener of this.listeners) listener()
  }
  private update(id: string, change: Partial<UploadBatch>) {
    if (this.lifetime?.signal.aborted) return
    this.batches = this.batches.map((b) => (b.id === id ? { ...b, ...change } : b))
    this.emit()
  }
  private file(id: string, index: number, change: Partial<FileProgress>) {
    const b = this.batches.find((b) => b.id === id)!
    this.update(id, { files: b.files.map((f, i) => (i === index ? { ...f, ...change } : f)) })
  }
  private saved(work: Work): SavedUpload {
    return {
      identities: work.identities,
      batch: this.batches.find((b) => b.id === work.id)!,
      fields: work.fields,
      uploadIds: work.uploadIds,
      frozen: work.frozen,
    }
  }
  private async restore(signal: AbortSignal) {
    if (!this.storage) return
    try {
      for (const { saved, files } of await storageWait(this.storage.load(), signal)) {
        signal.throwIfAborted()
        if (this.work.has(saved.batch.id)) continue
        if (saved.batch.files.every((f) => ['success', 'skipped'].includes(f.phase))) {
          await storageWait(this.storage.remove(saved.batch.id), signal)
          continue
        }
        const batch = {
          ...saved.batch,
          cancelling: false,
          running: false,
          recovered: true,
          needsFiles: saved.batch.files.some(
            (f, i) => !['success', 'skipped'].includes(f.phase) && !f.serverQueued && !files[i],
          ),
          files: saved.batch.files.map((f, i) =>
            ['success', 'skipped'].includes(f.phase) || f.serverQueued
              ? f
              : {
                  ...f,
                  phase: 'failed' as const,
                  error: files[i]
                    ? 'Interrupted upload. Resume to continue.'
                    : 'Local file is unavailable; select it again.',
                },
          ),
        }
        this.work.set(batch.id, {
          id: batch.id,
          identities: saved.identities,
          files,
          fields: saved.fields,
          uploadIds: saved.uploadIds,
          frozen: saved.frozen,
          controller: new AbortController(),
          persisted: true,
        })
        this.batches = [...this.batches, batch]
        if (batch.files.some((f) => f.serverQueued && f.phase === 'processing')) {
          this.update(batch.id, { running: true })
          this.monitor(batch.id)
        }
      }
      signal.throwIfAborted()
      void this.recoverServerJobs(signal)
      this.emit()
    } catch {
      /* New batches expose storage failures individually. */
    }
  }
  private async recoverServerJobs(signal: AbortSignal) {
    // The server may have accepted a completion whose HTTP response was lost.
    // Recover from stable IDs before requiring files again after a reload.
    for (const batch of this.batches.filter((b) => b.recovered)) {
      if (signal.aborted) return
      const work = this.work.get(batch.id)!
      const indexes = batch.files
        .map((f, i) => (!f.serverQueued && !['success', 'skipped'].includes(f.phase) ? i : -1))
        .filter((i) => i >= 0)
      try {
        for (let offset = 0; offset < indexes.length; offset += 100) {
          const group = indexes.slice(offset, offset + 100)
          const { jobs } = await checkUploadJobs(
            group.map((i) => work.uploadIds[i]),
            signal,
          )
          signal.throwIfAborted()
          for (const job of jobs) {
            const i = work.uploadIds.indexOf(job.uploadId)
            if (!group.includes(i)) continue
            this.file(batch.id, i, {
              serverQueued: true,
              queueState: job.state === 'processing' ? 'processing' : 'queued',
              phase: 'processing',
              percent: 99,
              error: undefined,
            })
            if (job.result) this.applyServerResult(batch.id, i, job.result)
            else if (job.state === 'failed')
              this.file(batch.id, i, { phase: 'failed', error: job.error ?? undefined })
          }
        }
        const current = this.batches.find((b) => b.id === batch.id)!
        const processing = current.files.some((f) => f.serverQueued && f.phase === 'processing')
        this.update(batch.id, {
          running: processing,
          needsFiles: current.files.some(
            (f, i) =>
              !['success', 'skipped'].includes(f.phase) && !f.serverQueued && !work.files[i],
          ),
        })
        if (processing) this.monitor(batch.id)
        await this.checkpoint(work)
      } catch {
        /* An offline browser retains its recovery state; no original is discarded. */
      }
    }
  }
  private async checkpoint(work: Work, index?: number) {
    if (!work.persisted || !this.storage || this.lifetime?.signal.aborted) return
    const signal = this.lifetime?.signal
    try {
      await storageWait(this.storage.checkpoint(this.saved(work), index), signal)
    } catch {
      if (signal?.aborted) return
      work.persisted = false
      this.update(work.id, {
        warning:
          'Browser storage is unavailable. Keep this tab open; restart recovery may be incomplete.',
      })
    }
  }
  start(files: File[], fields: Record<string, unknown>, label: string) {
    this.activate()
    files = files.filter((file) => !isUploadMetadata(file))
    const id = crypto.randomUUID()
    this.work.set(id, {
      id,
      identities: files.map(fileIdentity),
      files: [...files],
      fields: { ...fields },
      uploadIds: files.map(() => crypto.randomUUID()),
      frozen: files.map(() => null),
      controller: new AbortController(),
      persisted: false,
    })
    this.batches = [
      ...this.batches,
      {
        id,
        label,
        eventId: typeof fields.eventId === 'number' ? fields.eventId : undefined,
        running: true,
        files: files.map((f) => ({
          filename: f.name,
          sizeBytes: f.size,
          percent: 0,
          phase: 'waiting',
        })),
      },
    ]
    this.emit()
    void this.drain()
    return id
  }
  reselect(id: string, files: File[]) {
    const work = this.work.get(id)
    const batch = this.batches.find((b) => b.id === id)
    if (!work || !batch || batch.running) return
    let attached = 0
    for (let i = 0; i < batch.files.length; i++) {
      if (['success', 'skipped'].includes(batch.files[i].phase) || work.files[i]) continue
      const identity = work.identities?.[i]
      if (!identity) continue // Legacy batches recover using their stored blobs; never guess by name alone.
      const candidates = files.filter(
        (f) =>
          f.name === identity.name &&
          f.size === identity.size &&
          f.lastModified === identity.lastModified &&
          (!identity.relativePath ||
            !f.webkitRelativePath ||
            f.webkitRelativePath === identity.relativePath),
      )
      if (candidates.length === 1) {
        work.files[i] = candidates[0]
        attached++
      }
    }
    const missing = batch.files.filter(
      (f, i) => !['success', 'skipped'].includes(f.phase) && !f.serverQueued && !work.files[i],
    ).length
    this.update(id, {
      needsFiles: missing > 0,
      warning: missing
        ? `${attached} files matched. ${missing} originals still need to be selected; use the same files and folder.`
        : undefined,
    })
  }
  cancel(id: string) {
    const batch = this.batches.find((b) => b.id === id)
    const work = this.work.get(id)
    if (!batch?.running || !work || work.controller.signal.aborted) return
    work.controller.abort(new DOMException('Upload canceled. Retry to resume.', 'AbortError'))
    const cancelling = this.activeBatch === id
    this.update(id, {
      running: cancelling || batch.files.some((f) => f.serverQueued && f.phase === 'processing'),
      cancelling,
      warning:
        'Upload canceled. Saved files are kept; accepted processing jobs continue on the server. Files not yet sent can be retried.',
      files: batch.files.map((f) =>
        f.phase === 'waiting'
          ? { ...f, phase: 'failed', error: 'Upload canceled. Retry to resume.' }
          : f,
      ),
    })
    if (!cancelling) void this.checkpoint(work)
  }
  async resume(id: string, owner: string | null) {
    const lifetime = this.lifetime
    if (!lifetime || lifetime.signal.aborted) return
    const ownsLifetime = () => this.lifetime === lifetime && !lifetime.signal.aborted
    const batch = this.batches.find((b) => b.id === id)
    if (!batch || batch.running || batch.needsFiles) return
    try {
      const response = await fetch('/api/auth/me', {
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok)
        throw new Error(
          'Access is not restored yet. Keep this tab open and complete sign-in in the other tab.',
        )
      const user = await response.json()
      if (!ownsLifetime()) return
      if (!owner || !user.authenticated || user.username !== owner)
        throw new Error(
          'Sign in with the same account that started this upload. No files were sent.',
        )
      if (!user.canManagePersonal)
        throw new Error('This account does not currently have upload permission.')
      this.retry(id)
    } catch (error) {
      if (!ownsLifetime()) return
      this.update(id, {
        warning: error instanceof Error ? error.message : 'Unable to verify access. Please retry.',
      })
    }
  }
  retry(id: string) {
    const batch = this.batches.find((b) => b.id === id)
    if (!batch || batch.running || batch.needsFiles) return
    this.work.get(id)!.controller = new AbortController()
    this.authenticationPaused = false
    this.accessIssue = undefined
    this.update(id, {
      running: true,
      cancelling: false,
      recovered: false,
      accessIssue: undefined,
      warning: undefined,
      files: batch.files.map((f) =>
        f.phase === 'failed' ? { ...f, phase: 'waiting', percent: 0, error: undefined } : f,
      ),
    })
    void this.drain()
  }
  dismiss(id: string) {
    const batch = this.batches.find((b) => b.id === id)
    if (batch?.running) return
    const work = this.work.get(id)
    if (work && typeof window !== 'undefined')
      work.uploadIds
        .filter((_, i) => !['success', 'skipped'].includes(batch?.files[i]?.phase ?? 'failed'))
        .forEach((uploadId) => {
          void fetch(`/api/upload/chunk?uploadId=${uploadId}`, { method: 'DELETE' }).catch(() => {})
        })
    void this.storage?.remove(id).catch(() => {})
    this.work.delete(id)
    this.batches = this.batches.filter((b) => b.id !== id)
    this.emit()
  }
  private applyServerResult(id: string, index: number, data: UploadResult) {
    const work = this.work.get(id)
    if (!isUploadResult(data)) throw Error('Invalid upload result')
    const result = data.results[0]
    if (!work || !result) throw Error('Missing upload result')
    if (data.eventId) {
      work.fields.eventId = data.eventId
      this.update(id, { eventId: data.eventId })
    }
    this.file(id, index, {
      phase: result.status,
      percent: 100,
      photoId: result.photoId,
      existingFilename: result.existingFilename,
      error: undefined,
    })
  }
  private monitor(id: string) {
    const lifetime = this.lifetime
    if (!lifetime || lifetime.signal.aborted || this.monitors.has(id)) return
    const monitor: { timer?: ReturnType<typeof setTimeout> } = {}
    this.monitors.set(id, monitor)
    const ownsMonitor = () => !lifetime.signal.aborted && this.monitors.get(id) === monitor
    const stop = () => {
      clearTimeout(monitor.timer)
      if (this.monitors.get(id) === monitor) this.monitors.delete(id)
    }
    const tick = async () => {
      if (!ownsMonitor()) return
      const work = this.work.get(id)
      const batch = this.batches.find((b) => b.id === id)
      if (!work || !batch) {
        stop()
        return
      }
      const indexes = batch.files
        .map((f, i) => (f.serverQueued && f.phase === 'processing' ? i : -1))
        .filter((i) => i >= 0)
      if (!indexes.length) {
        stop()
        return
      }
      try {
        for (let offset = 0; offset < indexes.length; offset += 100) {
          const group = indexes.slice(offset, offset + 100)
          const { jobs } = await checkUploadJobs(
            group.map((i) => work.uploadIds[i]),
            lifetime.signal,
          )
          if (!ownsMonitor()) return
          if (!Array.isArray(jobs)) throw Error('Invalid processing status')
          if (
            this.batches
              .find((b) => b.id === id)
              ?.warning?.startsWith('Processing continues on the server. Status')
          )
            this.update(id, { warning: undefined })
          for (const i of group) {
            const job = jobs.find((j) => j.uploadId === work.uploadIds[i])
            if (!job)
              this.file(id, i, {
                phase: 'failed',
                error: 'Saved upload no longer exists. Reselect the original to upload again.',
                serverQueued: false,
              })
            else if (job.result) this.applyServerResult(id, i, job.result)
            else if (job.state === 'failed')
              this.file(id, i, {
                phase: 'failed',
                error: job.error || 'Processing failed; retry this file',
              })
            else
              this.file(id, i, { queueState: job.state === 'processing' ? 'processing' : 'queued' })
          }
        }
        const current = this.batches.find((b) => b.id === id)!
        const processing = current.files.some((f) => f.serverQueued && f.phase === 'processing')
        if (!processing && this.activeBatch !== id) {
          this.update(id, {
            running: false,
            needsFiles: current.files.some(
              (f, i) => f.phase === 'failed' && !f.serverQueued && !work.files[i],
            ),
          })
          if (current.eventId) this.notifyCompleted(current.eventId)
        }
        await this.checkpoint(work)
        if (!ownsMonitor()) return
        if (!processing) {
          stop()
          return
        }
      } catch (error) {
        if (!ownsMonitor()) return
        this.update(id, {
          warning:
            'Processing continues on the server. Status is temporarily unavailable; checking again.',
        })
        if ((error as { accessIssue?: string }).accessIssue) {
          this.update(id, {
            running: false,
            warning:
              'Processing continues on the server. Sign in again, then reload to check progress.',
          })
          stop()
          return
        }
      }
      if (ownsMonitor()) monitor.timer = setTimeout(tick, 5000)
    }
    monitor.timer = setTimeout(tick, 1000)
  }
  private notifyCompleted(eventId: number) {
    if (!this.lifetime?.signal.aborted) this.completed(eventId)
  }
  private async drain() {
    const lifetime = this.lifetime
    if (!lifetime || lifetime.signal.aborted || this.active === lifetime) return
    const ownsLifetime = () => this.lifetime === lifetime && !lifetime.signal.aborted
    this.active = lifetime
    try {
      await this.ready
      while (ownsLifetime()) {
        const batch = this.batches.find(
          (b) => b.running && b.files.some((f) => f.phase === 'waiting'),
        )
        if (!batch) break
        this.activeBatch = batch.id
        const work = this.work.get(batch.id)!
        const signal = work.controller.signal
        if (this.storage && !work.persisted) {
          try {
            await storageWait(
              this.storage.create(this.saved(work), work.files as File[]),
              lifetime.signal,
            )
            if (!ownsLifetime()) return
            work.persisted = true
          } catch {
            if (!ownsLifetime()) return
            this.update(batch.id, {
              warning:
                'Unable to save upload progress in this browser. Keep this tab open; recovery after closing may be unavailable.',
            })
          }
        }
        const runFile = async (i: number) => {
          if (!ownsLifetime() || signal.aborted) return
          const file = work.files[i]
          if (this.batches.find((b) => b.id === batch.id)!.files[i].phase !== 'waiting') return
          if (isUploadMetadata(file ?? { name: batch.files[i].filename })) {
            this.file(batch.id, i, {
              phase: 'skipped',
              percent: 100,
              skipReason: 'metadata',
              error: undefined,
            })
            await this.checkpoint(work, i)
            if (!ownsLifetime()) return
            work.files[i] = null
            return
          }
          if (batch.files[i].serverQueued) {
            try {
              const data = await retryQueuedUpload(work.uploadIds[i], signal)
              if (!ownsLifetime()) return
              if (data.queued) {
                this.file(batch.id, i, {
                  phase: 'processing',
                  queueState: 'queued',
                  error: undefined,
                })
                this.monitor(batch.id)
              } else this.applyServerResult(batch.id, i, data)
            } catch (error) {
              if (!ownsLifetime()) return
              this.file(batch.id, i, {
                phase: 'failed',
                error: error instanceof Error ? error.message : 'Unable to retry',
              })
            }
            await this.checkpoint(work)
            return
          }
          if (!file) {
            this.file(batch.id, i, {
              phase: 'failed',
              error: 'Local file is unavailable; select it again.',
            })
            return
          }
          try {
            if (!work.frozen[i]) work.frozen[i] = { ...work.fields }
            await this.checkpoint(work)
            if (!ownsLifetime()) return
            signal.throwIfAborted()
            const execute = () => {
              signal.throwIfAborted()
              return this.send(
                file,
                { ...work.frozen[i] },
                (p) => {
                  if (ownsLifetime() && !signal.aborted) this.file(batch.id, i, p)
                },
                work.uploadIds[i],
                signal,
              )
            }
            const data =
              typeof navigator !== 'undefined' && navigator.locks
                ? await navigator.locks.request(
                    'photo-upload:' + work.uploadIds[i],
                    { signal },
                    execute,
                  )
                : await execute()
            if (!ownsLifetime()) return
            if (data.queued) {
              this.file(batch.id, i, {
                phase: 'processing',
                serverQueued: true,
                queueState: 'queued',
                percent: 99,
                error: undefined,
              })
              await this.checkpoint(work, i)
              if (!ownsLifetime()) return
              work.files[i] = null
              this.monitor(batch.id)
              return
            }
            if (data.eventId) {
              work.fields.eventId = data.eventId
              this.update(batch.id, { eventId: data.eventId })
            }
            const result = data.results?.[0]
            if (!result || !['success', 'skipped'].includes(result.status))
              throw new Error('Missing upload result')
            this.file(batch.id, i, {
              phase: result.status,
              percent: 100,
              photoId: result.photoId,
              existingFilename: result.existingFilename,
              error: undefined,
            })
            await this.checkpoint(work, i)
            if (!ownsLifetime()) return
            work.files[i] = null
          } catch (error) {
            if (!ownsLifetime()) return
            const denied = error as {
              authenticationRequired?: boolean
              accessIssue?: UploadBatch['accessIssue']
            }
            if (denied.authenticationRequired || denied.accessIssue) {
              this.authenticationPaused = true
              this.accessIssue = denied.accessIssue ?? 'authentication'
              this.update(batch.id, {
                accessIssue: this.accessIssue,
                warning:
                  'Upload is pausing after an access error. Existing requests are finishing; no new files will start. Keep this tab open.',
              })
            }
            this.file(batch.id, i, {
              phase: 'failed',
              error: signal.aborted
                ? 'Upload canceled. Retry to resume.'
                : error instanceof Error
                  ? error.message
                  : 'Upload failed',
            })
            await this.checkpoint(work)
          }
        }
        // The server serializes album creation by the uploader-scoped source key.
        let next = 0
        await Promise.all(
          Array.from({ length: 4 }, async () => {
            while (
              ownsLifetime() &&
              next < work.files.length &&
              !this.authenticationPaused &&
              !signal.aborted
            ) {
              const index = next++
              await runFile(index)
            }
          }),
        )
        if (!ownsLifetime()) return
        if (this.authenticationPaused) {
          // Let the four in-flight files settle, but never send the remaining batch
          // under an expired session. Preserve every file and stable upload ID.
          for (const pending of this.batches.filter((b) => b.running)) {
            this.update(pending.id, {
              running: pending.files.some((f) => f.serverQueued && f.phase === 'processing'),
              accessIssue: this.accessIssue,
              warning:
                this.accessIssue === 'authentication'
                  ? 'Upload paused. Sign in again in a new tab, then choose Check access and resume here. Keep this tab open to retain your selected files.'
                  : 'Upload paused after an access rejection. Your selected files are retained in this tab. Check access and resume after the issue is resolved.',
              files: pending.files.map((f) =>
                f.phase === 'waiting'
                  ? {
                      ...f,
                      phase: 'failed' as const,
                      error: 'Paused after an access error; file has not been uploaded.',
                    }
                  : f,
              ),
            })
            await this.checkpoint(this.work.get(pending.id)!)
            if (!ownsLifetime()) return
          }
        }
        this.update(batch.id, {
          running: this.batches
            .find((b) => b.id === batch.id)!
            .files.some((f) => f.serverQueued && f.phase === 'processing'),
          cancelling: false,
        })
        this.activeBatch = undefined
        await this.checkpoint(work)
        if (!ownsLifetime()) return
        const eventId = this.batches.find((b) => b.id === batch.id)?.eventId
        if (eventId && !this.authenticationPaused) this.notifyCompleted(eventId)
      }
    } finally {
      if (this.active === lifetime) {
        this.activeBatch = undefined
        this.active = undefined
      }
    }
  }
}
