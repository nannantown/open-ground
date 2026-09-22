import type { CustomModuleDef } from './types'

export const NENE_ORIGIN = 'http://127.0.0.1:8899'

/** Never accept a URL from custom source or a postMessage. The capability is
 *  limited to a named local integration on a different origin from the host. */
export function localAppUrl(module: Pick<CustomModuleDef, 'localApp'>, hostOrigin: string): string | null {
  return module.localApp === 'nene-songs' && hostOrigin !== NENE_ORIGIN
    ? `${NENE_ORIGIN}/` : null
}
