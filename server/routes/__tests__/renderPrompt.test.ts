import { describe, it, expect } from 'vitest'
import { renderPrompt } from '../run'
import type { ProjectData } from '../../../src/lib/types'

const data = (over: Partial<ProjectData> = {}): ProjectData => ({
  description: '',
  tasks: [],
  milestones: [],
  goals: [],
  notes: '',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

describe('renderPrompt placeholder substitution', () => {
  it('substitutes the basic placeholders', () => {
    const out = renderPrompt(
      'P:{{name}} T:{{tasks}} N:{{notes}} D:{{description}}',
      data({ notes: 'my notes', description: 'desc' }),
      'Proj',
      'task line',
      '',
    )
    expect(out).toBe('P:Proj T:task line N:my notes D:desc')
  })

  it('does NOT interpret $-sequences in notes (the Pass 8 bug)', () => {
    // `$&` / `$1` / `$\`` are special in a String.replace *string* replacement;
    // with a function replacer they must be inserted verbatim.
    const notes = 'shell: echo $1 and $& and ${FOO} and $`done'
    const out = renderPrompt('{{notes}}', data({ notes }), 'P', 'T', '')
    expect(out).toBe(notes)
  })

  it('does NOT interpret $-sequences in task line, name, or repoDigest', () => {
    const out = renderPrompt(
      '{{repoDigest}}|{{tasks}}|{{name}}',
      data(),
      'name$&x',
      'task$1y',
      'digest$`z',
    )
    expect(out).toBe('digest$`z|task$1y|name$&x')
  })

  it('prepends repoDigest when the template lacks the placeholder', () => {
    const out = renderPrompt('body $& here', data(), 'P', 'T', 'DIGEST$1')
    expect(out).toBe('DIGEST$1\n\n---\n\nbody $& here')
  })

  it('replaces every occurrence (global)', () => {
    const out = renderPrompt('{{name}}-{{name}}', data(), 'X', 'T', '')
    expect(out).toBe('X-X')
  })
})
