import { describe, it, expect } from 'vitest'
import {
  preprocessScreenSource,
  buildScreenSrcdoc,
  DEFAULT_SCREEN_SOURCE,
} from './screenSrcdoc'

describe('preprocessScreenSource', () => {
  it('rewrites a named lucide import to a require destructure', () => {
    const out = preprocessScreenSource(`import { Check, X } from 'lucide-react'`)
    expect(out).toContain('require("lucide-react")')
    expect(out).toContain('Check')
    expect(out).toContain('X')
    expect(out).not.toMatch(/^\s*import\b/m)
  })

  it('rewrites a default import', () => {
    const out = preprocessScreenSource(`import React from 'react'`)
    expect(out).toContain('require("react")')
    expect(out).not.toMatch(/^\s*import\b/m)
  })

  it('rewrites a namespace import', () => {
    const out = preprocessScreenSource(`import * as React from 'react'`)
    expect(out).toContain('var React = require("react")')
  })

  it('drops a type-only import', () => {
    const out = preprocessScreenSource(`import type { Foo } from './types'`)
    expect(out.trim()).toBe('')
  })

  it('drops a side-effect import', () => {
    const out = preprocessScreenSource(`import './styles.css'`)
    expect(out.trim()).toBe('')
  })

  it('handles an import with a trailing line comment (no surviving import)', () => {
    const out = preprocessScreenSource(`import { useState } from 'react' // hi`)
    expect(out).not.toMatch(/\bimport\b/)
    expect(out).toContain('require("react")')
    expect(out).toContain('// hi')
  })

  it('handles same-line code after an import', () => {
    const out = preprocessScreenSource(`import X from 'react'; const y = 1`)
    expect(out).not.toMatch(/\bimport\b/)
    expect(out).toContain('const y = 1')
  })

  it('captures `export { App as default }` as the mount target', () => {
    const out = preprocessScreenSource(`function App(){ return null }\nexport { App as default }`)
    expect(out).toContain('window.__SCREEN_DEFAULT = App')
    expect(out).not.toMatch(/\bexport\b/)
  })

  it('strips a plain `export { Foo, Bar }` list', () => {
    const out = preprocessScreenSource(`const Foo = 1\nconst Bar = 2\nexport { Foo, Bar }`)
    expect(out).not.toMatch(/\bexport\b/)
  })

  it('rewrites `export { X as default } from "mod"` through require', () => {
    const out = preprocessScreenSource(`export { Button as default } from './button'`)
    expect(out).toContain('window.__SCREEN_DEFAULT = require("./button").Button')
    expect(out).not.toMatch(/\bexport\b/)
  })

  it('captures a named default export as the mount target', () => {
    const out = preprocessScreenSource(`export default function Home() { return null }`)
    expect(out).toContain('function Home()')
    expect(out).toContain('window.__SCREEN_DEFAULT = Home')
    expect(out).not.toMatch(/export\s+default/)
  })

  it('captures an anonymous / expression default export', () => {
    const out = preprocessScreenSource(`export default () => null`)
    expect(out).toContain('window.__SCREEN_DEFAULT = () => null')
  })

  it('strips export keyword from named exports', () => {
    const out = preprocessScreenSource(`export const x = 1\nexport function f() {}`)
    expect(out).toContain('const x = 1')
    expect(out).toContain('function f() {}')
    expect(out).not.toMatch(/^\s*export\b/m)
  })
})

describe('buildScreenSrcdoc', () => {
  it('react: injects React, Babel, lucide, Tailwind + the preprocessed source', () => {
    const doc = buildScreenSrcdoc(`export default function A(){ return null }`, 'react')
    expect(doc).toContain('react@18/umd')
    expect(doc).toContain('@babel/standalone')
    expect(doc).toContain('lucide@latest')
    expect(doc).toContain('cdn.tailwindcss.com')
    expect(doc).toContain('window.__SCREEN_DEFAULT = A')
    expect(doc).toContain('id="__opengrnd_src"')
  })

  it('injects props as JSON', () => {
    const doc = buildScreenSrcdoc(DEFAULT_SCREEN_SOURCE, 'react', 'light', {
      title: 'Hello',
    })
    expect(doc).toContain('window.__SCREEN_PROPS = {"title":"Hello"}')
  })

  it('escapes a </script> in the source so it cannot break out', () => {
    const doc = buildScreenSrcdoc(
      `function App(){ return null } // </script><script>alert(1)</script>`,
      'react',
    )
    expect(doc).not.toContain('</script><script>alert(1)')
  })

  it('prefers an explicit default export over a bare App helper', () => {
    const doc = buildScreenSrcdoc(
      `function App(){ return null }\nexport default function Screen(){ return null }`,
      'react',
    )
    expect(doc).toContain('window.__SCREEN_DEFAULT || (typeof App')
  })

  it('escapes a </script> inside a prop value so it cannot break out', () => {
    const doc = buildScreenSrcdoc(`function App(){ return null }`, 'react', 'light', {
      evil: '</script><script>alert(1)</script>',
    })
    expect(doc).not.toContain('</script><script>alert(1)')
    expect(doc).toContain('\\u003c/script>')
  })

  it('html: inlines the markup and skips the React runtime', () => {
    const doc = buildScreenSrcdoc(`<div class="p-4">hi</div>`, 'html')
    expect(doc).toContain('<div class="p-4">hi</div>')
    expect(doc).toContain('cdn.tailwindcss.com')
    expect(doc).not.toContain('react@18/umd')
  })
})
