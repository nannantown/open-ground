import { describe, expect, it } from 'vitest'
import {
  buildInspectScript,
  INSPECT_MARKER,
  INSPECT_HTML_LIMIT,
  INSPECT_TEXT_LIMIT,
} from './canvasInspect'
import { buildMockSrcdoc } from './mockSrcdoc'
import { buildScreenSrcdoc } from './screenSrcdoc'

describe('buildInspectScript', () => {
  it('carries the marker and the message protocol', () => {
    const s = buildInspectScript()
    expect(s).toContain(INSPECT_MARKER)
    // parent → iframe toggle …
    expect(s).toContain("d.og !== 'inspect'")
    // … and iframe → parent pick report (sandbox has no same-origin, so '*').
    expect(s).toContain("og: 'pick'")
    expect(s).toContain("parent.postMessage")
    expect(s).toContain("}, '*')")
  })

  it('bakes the truncation limits in', () => {
    const s = buildInspectScript()
    expect(s).toContain(`slice(0, ${INSPECT_HTML_LIMIT})`)
    expect(s).toContain(`slice(0, ${INSPECT_TEXT_LIMIT})`)
  })

  it('contains no </script so it survives <script> inlining', () => {
    expect(buildInspectScript().toLowerCase()).not.toContain('</script')
  })

  it('is injected into both mock srcdoc variants', () => {
    expect(buildMockSrcdoc('function App() { return null }', 'react')).toContain(INSPECT_MARKER)
    expect(buildMockSrcdoc('<div>hi</div>', 'html')).toContain(INSPECT_MARKER)
  })

  it('is injected into both screen srcdoc variants', () => {
    expect(buildScreenSrcdoc('export default function S() { return null }', 'react')).toContain(
      INSPECT_MARKER,
    )
    expect(buildScreenSrcdoc('<div>hi</div>', 'html')).toContain(INSPECT_MARKER)
  })
})
