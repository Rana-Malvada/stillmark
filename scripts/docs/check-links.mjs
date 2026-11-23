// Check tracked and new non-ignored documentation; never accept an ignored local artifact.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateDocuments } from './validate.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const files = [
  ...new Set(
    execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\0')
      .filter((file) => file && existsSync(path.join(root, file))),
  ),
]
const documents = new Map(
  files
    .filter((file) => file.endsWith('.md'))
    .map((file) => [file, readFileSync(path.join(root, file), 'utf8')]),
)
const errors = validateDocuments(documents, files)
for (const error of errors) console.error(error)
if (errors.length) process.exitCode = 1
else
  console.log(`Documentation links and index coverage passed (${documents.size} Markdown files).`)
