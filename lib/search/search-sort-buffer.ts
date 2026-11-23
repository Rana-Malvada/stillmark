import { createReadStream } from 'node:fs'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Exact external merge sort. Small searches stay in memory; large searches spill
 * private, request-scoped runs. No database locks or candidate truncation. */
export class SearchSortBuffer<T> {
  private buffer: T[] = []
  private runs: string[] = []
  private directory?: string
  private serial = 0
  private bytes = 0
  private sealed = false
  size = 0
  constructor(
    private compare: (a: T, b: T) => number,
    private signal?: AbortSignal,
    private capacity = 8192,
    private byteLimit = 512 * 1024 * 1024,
  ) {}
  async add(rows: Iterable<T>) {
    if (this.sealed) throw new Error('Search buffer already sealed')
    for (const row of rows) {
      this.signal?.throwIfAborted()
      this.buffer.push(row)
      this.size++
      if (this.buffer.length >= this.capacity) await this.flush()
    }
  }
  private async write(rows: AsyncIterable<T> | Iterable<T>) {
    this.signal?.throwIfAborted()
    this.directory ??= await mkdtemp(join(tmpdir(), 'stillmark-search-'))
    const path = join(this.directory, `${this.serial++}.jsonl`)
    const file = await open(path, 'wx', 0o600)
    let chunk = ''
    try {
      for await (const row of rows) {
        this.signal?.throwIfAborted()
        const line = JSON.stringify(row) + '\n'
        this.bytes += Buffer.byteLength(line)
        if (this.bytes > this.byteLimit) throw new Error('Search scratch budget exceeded')
        chunk += line
        if (chunk.length >= 65536) {
          await file.writeFile(chunk)
          chunk = ''
        }
      }
      if (chunk) await file.writeFile(chunk)
    } finally {
      await file.close()
    }
    return path
  }
  private async flush() {
    if (!this.buffer.length) return
    this.buffer.sort(this.compare)
    this.runs.push(await this.write(this.buffer))
    this.buffer = []
  }
  private async *read(path: string): AsyncGenerator<T> {
    const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 16384 })
    let pending = ''
    try {
      for await (const chunk of stream) {
        this.signal?.throwIfAborted()
        pending += chunk
        let end: number
        while ((end = pending.indexOf('\n')) >= 0) {
          yield JSON.parse(pending.slice(0, end)) as T
          pending = pending.slice(end + 1)
        }
      }
      if (pending) throw new Error('Incomplete search scratch record')
    } finally {
      stream.destroy()
    }
  }

  private async *merge(paths: string[]): AsyncGenerator<T> {
    const readers = paths.map((path) => this.read(path))
    try {
      const heads = await Promise.all(readers.map((reader) => reader.next()))
      while (true) {
        this.signal?.throwIfAborted()
        let best = -1
        for (let i = 0; i < heads.length; i++)
          if (!heads[i].done && (best < 0 || this.compare(heads[i].value!, heads[best].value!) < 0))
            best = i
        if (best < 0) return
        yield heads[best].value!
        heads[best] = await readers[best].next()
      }
    } finally {
      await Promise.all(readers.map((reader) => reader.return(undefined)))
    }
  }
  async *ordered(): AsyncGenerator<T> {
    if (!this.sealed) {
      this.sealed = true
      if (this.runs.length) await this.flush()
      else this.buffer.sort(this.compare)
      // Limit open files and merge heads independently of the candidate count.
      while (this.runs.length > 16) {
        const next: string[] = []
        for (let i = 0; i < this.runs.length; i += 16) {
          const group = this.runs.slice(i, i + 16)
          next.push(await this.write(this.merge(group)))
          await Promise.all(group.map((path) => rm(path)))
        }
        this.runs = next
      }
    }
    if (this.runs.length) yield* this.merge(this.runs)
    else
      for (const row of this.buffer) {
        this.signal?.throwIfAborted()
        yield row
      }
  }
  async dispose() {
    this.buffer = []
    this.runs = []
    if (this.directory) await rm(this.directory, { recursive: true, force: true })
  }
}
