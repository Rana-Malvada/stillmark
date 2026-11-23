import { objects } from '../../config/deployment.mjs'
// Paths written by background workers to the derived stage. Everything else is an
// original or upload-derived file on the originals stage.
const DERIVED_PREFIXES = ['display/prepared/', 'faces/']
/** Fixed stage routing only; callers must validate paths and authorize against the catalog. */
export function mediaStage(path: string) {
  return DERIVED_PREFIXES.some((prefix) => path.startsWith(prefix))
    ? '@' + objects.derived
    : '@' + objects.originals
}
