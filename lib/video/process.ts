import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setPriority } from 'node:os'
import { VideoPreparationError } from './video-preparation-error'

function binary(name: 'ffmpeg' | 'ffprobe') {
  const bundled = join(process.cwd(), 'bin', name)
  if (existsSync(bundled)) return bundled
  // Development uses the same pinned binaries as the deployment build.
  return name === 'ffmpeg'
    ? (require('ffmpeg-static') as string)
    : (require('ffprobe-static').path as string)
}

export function run(
  name: 'ffmpeg' | 'ffprobe',
  args: string[],
  timeout: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new VideoPreparationError('Video preparation cancelled.'))
      return
    }
    const child = spawn(binary(name), args, { stdio: ['ignore', 'pipe', 'pipe'] })
    if (name === 'ffmpeg' && child.pid) {
      try {
        setPriority(child.pid, 10)
      } catch {
        /* Thread limits still bound the converter if scheduling priority is unavailable. */
      }
    }
    const abort = () => child.kill('SIGKILL')
    signal?.addEventListener('abort', abort, { once: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeout)
    child.stdout.on('data', (b) => {
      if (stdout.length < 1000000) stdout += b.toString()
    })
    child.stderr.on('data', (b) => {
      stderr = (stderr + b.toString()).slice(-4000)
    })
    child.on('error', () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(new VideoPreparationError('The video converter is unavailable.'))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (code === 0 && !signal?.aborted) resolve(stdout)
      else {
        console.error('[video-conversion]', name, timedOut ? 'timeout' : stderr)
        reject(
          new VideoPreparationError(
            timedOut
              ? 'Video preparation timed out. The original is unchanged.'
              : 'This video could not be converted. The original is unchanged.',
          ),
        )
      }
    })
  })
}
