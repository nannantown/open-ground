import { describe, it, expect } from 'vitest'
import { buildMockSrcdoc } from './mockSrcdoc'

describe('buildMockSrcdoc', () => {
  it('react: loads a pinned Babel 8 + a classic-runtime react preset', () => {
    const doc = buildMockSrcdoc(`function App(){ return <div/> }`, 'react')
    // Pinned major so a future Babel 9 can't silently break the preview the way
    // the unpinned 7→8 bump did.
    expect(doc).toContain('@babel/standalone@8')
    // Babel 8's preset-react defaults to the automatic JSX runtime, which emits
    // an unresolvable `import` from react/jsx-runtime (only the React UMD global
    // is loaded). We register + use a classic-runtime preset so JSX compiles to
    // React.createElement instead.
    expect(doc).toContain("Babel.registerPreset('react-classic'")
    expect(doc).toContain('data-presets="react-classic"')
  })

  it('html: skips the React runtime entirely', () => {
    const doc = buildMockSrcdoc(`<div class="p-4">hi</div>`, 'html')
    expect(doc).toContain('<div class="p-4">hi</div>')
    expect(doc).not.toContain('@babel/standalone')
  })
})
