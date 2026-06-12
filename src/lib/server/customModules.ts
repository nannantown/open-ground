// customModules.ts — on-disk CRUD for user-built tab modules.
//
// Layout (docs/CUSTOM_TABS_PLAN.md): meta lives in ONE file —
// ~/.openground/custom-modules/index.json (CustomModuleDef[]) — and each
// module's component source lives as a plain file in its own dir
// (~/.openground/custom-modules/<uuid>/source.tsx|html) so the sidebar claude
// session can edit it like any other file and the tab hot-reloads on mtime.
//
// SECURITY: every id that reaches a path builder here MUST be a bare uuid —
// `isValidModuleId` (regex) is checked at the top of each id-taking function,
// so a traversal payload (`../…`) can never reach join(). Routes additionally
// 404 ids that aren't in the index.
//
// CONCURRENCY: index writes are read-modify-write, serialized through a
// module-level single-flight chain (the store.ts setSettings pattern) so two
// concurrent mutations can't lose updates.

import { readFile, mkdir, rm, stat } from 'fs/promises'
import { randomUUID } from 'crypto'
import {
  customModulesIndexFile,
  customModuleDir,
  customModuleSourceFile,
  ensureCustomModulesDir,
} from './paths'
import { atomicWriteJson, atomicWriteText } from './atomicWrite'
import type { CustomModuleDef, CustomModuleFramework, CustomModuleSourceResponse } from '../types'

// The route-level id contract from the plan: a bare lowercase/uppercase hex
// uuid, nothing else, BEFORE any filesystem path is built from it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isValidModuleId = (id: string): boolean => UUID_RE.test(id)

// --- index.json access -------------------------------------------------------

// Read never throws: a missing/garbled index means "no modules yet" (mirrors
// store.ts readJson). Non-array JSON is treated the same.
const readIndex = async (): Promise<CustomModuleDef[]> => {
  await ensureCustomModulesDir()
  try {
    const raw = await readFile(customModulesIndexFile(), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as CustomModuleDef[]) : []
  } catch {
    return []
  }
}

// Single-flight chain for index mutations (store.ts setSettings pattern):
// every mutation re-reads inside the chain, so concurrent calls can't clobber
// each other's entries. The chain survives a failed write (catch(() => {})).
let indexChain: Promise<unknown> = Promise.resolve()
const mutateIndex = <T>(
  fn: (defs: CustomModuleDef[]) => Promise<{ defs: CustomModuleDef[]; result: T }> | { defs: CustomModuleDef[]; result: T },
): Promise<T> => {
  const run = indexChain.then(async () => {
    const current = await readIndex()
    const { defs, result } = await fn(current)
    await atomicWriteJson(customModulesIndexFile(), defs)
    return result
  })
  indexChain = run.catch(() => {})
  return run
}

export const listModules = (): Promise<CustomModuleDef[]> => readIndex()

export const getModule = async (id: string): Promise<CustomModuleDef | null> => {
  if (!isValidModuleId(id)) return null
  const defs = await readIndex()
  return defs.find((d) => d.id === id) ?? null
}

// --- starter source ----------------------------------------------------------

// What a freshly created module renders before claude (or the owner) edits it:
// the label + description as a placeholder. The react flavor is a default-export
// component (the shape src/lib/screenSrcdoc.ts renders inside the sandboxed
// iframe — Tailwind classes + lucide-react available, no other imports).
// Strings are inlined via JSON.stringify so quotes/newlines in the user's
// label/description can't break out of the generated code.
export const starterSource = (
  label: string,
  description: string,
  framework: CustomModuleFramework,
): string => {
  if (framework === 'html') {
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return [
      '<!doctype html>',
      '<html>',
      '<body style="margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;flex-direction:column;gap:12px;font-family:system-ui;background:#0a0a0a;color:#fff;text-align:center;padding:32px">',
      `  <h1 style="margin:0;font-size:24px">${esc(label)}</h1>`,
      `  <p style="margin:0;max-width:480px;opacity:.7;font-size:14px">${esc(description)}</p>`,
      '  <p style="margin:0;opacity:.4;font-size:12px">Edit source.html to build this tab.</p>',
      '</body>',
      '</html>',
      '',
    ].join('\n')
  }
  return [
    `const LABEL = ${JSON.stringify(label)}`,
    `const DESCRIPTION = ${JSON.stringify(description)}`,
    '',
    'export default function CustomTab() {',
    '  return (',
    '    <div className="flex min-h-screen flex-col items-center justify-center gap-3 p-8 text-center">',
    '      <h1 className="text-2xl font-semibold">{LABEL}</h1>',
    '      <p className="max-w-md text-sm opacity-70">{DESCRIPTION}</p>',
    '      <p className="text-xs opacity-40">Edit source.tsx to build this tab.</p>',
    '    </div>',
    '  )',
    '}',
    '',
  ].join('\n')
}

// --- CRUD ---------------------------------------------------------------------

export interface CreateModuleInput {
  label: string
  description: string
  framework?: CustomModuleFramework
}

// Create a new LOCAL module: mint a uuid, write the starter source into its
// dir, then append the def to the index (inside the chain so a concurrent
// create can't drop it).
export const createModule = async (input: CreateModuleInput): Promise<CustomModuleDef> => {
  const framework: CustomModuleFramework = input.framework === 'html' ? 'html' : 'react'
  const now = new Date().toISOString()
  const def: CustomModuleDef = {
    id: randomUUID(),
    label: input.label,
    description: input.description,
    framework,
    origin: 'local',
    createdAt: now,
    updatedAt: now,
  }
  await mkdir(customModuleDir(def.id), { recursive: true })
  await atomicWriteText(
    customModuleSourceFile(def.id, framework),
    starterSource(def.label, def.description, framework),
  )
  return mutateIndex((defs) => ({ defs: [...defs, def], result: def }))
}

// Read the module's source + mtime (feeds the iframe and the hot-reload poll).
// null when the id is invalid, unknown, or the source file vanished.
export const readModuleSource = async (
  id: string,
): Promise<CustomModuleSourceResponse | null> => {
  const def = await getModule(id)
  if (!def) return null
  const path = customModuleSourceFile(id, def.framework)
  try {
    const [source, st] = await Promise.all([readFile(path, 'utf8'), stat(path)])
    return { source, mtimeMs: st.mtimeMs }
  } catch {
    return null
  }
}

export interface UpdateModuleInput {
  label?: string
  description?: string
  source?: string
}

// Patch meta and/or overwrite the source file. Returns the updated def, or
// null when the id is invalid/unknown.
export const updateModule = async (
  id: string,
  patch: UpdateModuleInput,
): Promise<CustomModuleDef | null> => {
  if (!isValidModuleId(id)) return null
  return mutateIndex(async (defs) => {
    const idx = defs.findIndex((d) => d.id === id)
    if (idx === -1) return { defs, result: null }
    const updated: CustomModuleDef = {
      ...defs[idx],
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      updatedAt: new Date().toISOString(),
    }
    if (patch.source !== undefined) {
      await atomicWriteText(customModuleSourceFile(id, updated.framework), patch.source)
    }
    const next = [...defs]
    next[idx] = updated
    return { defs: next, result: updated }
  })
}

// Remove the module dir + its index entry. false when invalid/unknown.
export const deleteModule = async (id: string): Promise<boolean> => {
  if (!isValidModuleId(id)) return false
  return mutateIndex(async (defs) => {
    const idx = defs.findIndex((d) => d.id === id)
    if (idx === -1) return { defs, result: false }
    await rm(customModuleDir(id), { recursive: true, force: true })
    return { defs: defs.filter((d) => d.id !== id), result: true }
  })
}

// Stamp publish metadata onto a local def after a successful marketplace
// upsert. Returns the updated def (null when invalid/unknown).
export const markPublished = async (
  id: string,
  meta: { remoteId: string; version: number; publishedAt: string },
): Promise<CustomModuleDef | null> => {
  if (!isValidModuleId(id)) return null
  return mutateIndex((defs) => {
    const idx = defs.findIndex((d) => d.id === id)
    if (idx === -1) return { defs, result: null }
    const updated: CustomModuleDef = {
      ...defs[idx],
      remoteId: meta.remoteId,
      version: meta.version,
      publishedAt: meta.publishedAt,
      updatedAt: new Date().toISOString(),
    }
    const next = [...defs]
    next[idx] = updated
    return { defs: next, result: updated }
  })
}

export interface InstallModuleInput {
  remoteId: string
  label: string
  description: string
  framework: CustomModuleFramework
  version: number
  publishedAt: string
  source: string
}

// Install (or re-install) a marketplace row locally with origin 'installed'.
// Re-installing the same remoteId UPDATES the existing local copy in place
// (same local uuid — its tab keeps working) instead of duplicating it.
export const installModule = async (input: InstallModuleInput): Promise<CustomModuleDef> => {
  return mutateIndex(async (defs) => {
    const now = new Date().toISOString()
    const existing = defs.find((d) => d.origin === 'installed' && d.remoteId === input.remoteId)
    const def: CustomModuleDef = existing
      ? {
          ...existing,
          label: input.label,
          description: input.description,
          framework: input.framework,
          version: input.version,
          publishedAt: input.publishedAt,
          updatedAt: now,
        }
      : {
          id: randomUUID(),
          label: input.label,
          description: input.description,
          framework: input.framework,
          origin: 'installed',
          createdAt: now,
          updatedAt: now,
          remoteId: input.remoteId,
          version: input.version,
          publishedAt: input.publishedAt,
        }
    await mkdir(customModuleDir(def.id), { recursive: true })
    await atomicWriteText(customModuleSourceFile(def.id, def.framework), input.source)
    // Invariant: exactly one source flavor exists per module dir. A re-install
    // that switched framework must not leave the stale other-flavor file behind.
    await rm(
      customModuleSourceFile(def.id, def.framework === 'html' ? 'react' : 'html'),
      { force: true },
    )
    const next = existing ? defs.map((d) => (d.id === def.id ? def : d)) : [...defs, def]
    return { defs: next, result: def }
  })
}
