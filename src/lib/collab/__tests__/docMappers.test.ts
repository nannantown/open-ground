import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import type { CanvasFile, ProjectData } from '../../types'
import {
  BOARD_ROOT,
  boardDocToProjectData,
  projectDataToBoardDoc,
  readBoardCanvasIndex,
  writeBoardCanvasIndex,
} from '../boardDoc'
import { CANVAS_ROOT, canvasFileToDoc, docToCanvasFile } from '../canvasDoc'

const task = (id: string, over: Partial<ProjectData['tasks'][number]> = {}) => ({
  id,
  title: id,
  done: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  boardColumn: 'todo' as const,
  ...over,
})

const sampleData = (): ProjectData => ({
  description: 'demo project',
  descriptionJa: 'デモ案件',
  tasks: [
    task('t1', { boardOrder: 0 }),
    task('t2', {
      done: true,
      boardColumn: 'done',
      boardOrder: 1,
      dependsOn: ['t1'],
      run: { model: 'opus', effort: 'high' },
      attachments: [{ id: 'a1', name: 'x.png', mime: 'image/png' }],
    }),
  ],
  tabOrder: ['terminal', 'board'], // personal — must NOT enter the doc
  customTabs: ['custom:abc'], // personal
  config: { completionFlow: 'pr', members: ['Aoi'] },
  launch: { model: 'fable' }, // personal
  notes: 'board notes\nsecond line',
  updatedAt: '2026-01-03T00:00:00.000Z',
})

const sampleCanvas = (): CanvasFile => ({
  id: 'c1',
  name: 'Untitled',
  rev: 0,
  viewport: { x: 10, y: 20, zoom: 1.5 }, // personal — out of the doc
  elements: [
    { id: 'e1', type: 'sticky', x: 0, y: 0, width: 100, height: 80, text: 'hi', color: '#ff0' },
    { id: 'e2', type: 'frame', x: 50, y: 50, text: 'Frame', rotation: 15 },
  ],
  chats: [],
  activeChatId: null,
  sidebarOpen: false,
  sidebarWidth: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
})

const ids = (d: { tasks: { id: string }[] }) => d.tasks.map((t) => t.id)
const tById = (d: ProjectData, id: string) => d.tasks.find((t) => t.id === id)!

describe('board doc mapper', () => {
  it('round-trips shared fields and ignores personal/central fields', () => {
    const data = sampleData()
    const doc = new Y.Doc()
    projectDataToBoardDoc(doc, data)
    const out = boardDocToProjectData(doc, data)
    expect(out.tasks).toEqual(data.tasks)
    expect(out.notes).toBe(data.notes)
    expect(out.description).toBe(data.description)
    expect(out.descriptionJa).toBe(data.descriptionJa)
    expect(out.config).toEqual(data.config)
    expect(out.tabOrder).toEqual(data.tabOrder) // from base, not the doc
    expect(out.launch).toEqual(data.launch)
    const map = doc.getMap(BOARD_ROOT)
    expect(map.has('m:tabOrder')).toBe(false)
    expect(map.has('m:launch')).toBe(false)
  })

  it('seed is idempotent (zero Y updates on identical re-apply)', () => {
    const data = sampleData()
    const doc = new Y.Doc()
    projectDataToBoardDoc(doc, data)
    let updates = 0
    doc.on('update', () => {
      updates++
    })
    projectDataToBoardDoc(doc, data)
    expect(updates).toBe(0)
  })

  // THE regression test for the flat-map fix: two peers each seed a FRESH doc
  // from their OWN disk (no shared base — the real client-driven topology). The
  // old nested-Y.Map / Y.Array encoding duplicated ids and dropped fields here.
  it('two INDEPENDENTLY-seeded docs converge to the union (no duplicates)', () => {
    const a = new Y.Doc()
    projectDataToBoardDoc(a, { ...sampleData(), tasks: [task('t1'), task('t2', { title: 'A2' })] })
    const b = new Y.Doc()
    projectDataToBoardDoc(b, { ...sampleData(), tasks: [task('t1'), task('t3', { title: 'B3' })] })
    // exchange (independent origins, both directions)
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    const ao = boardDocToProjectData(a, sampleData())
    const bo = boardDocToProjectData(b, sampleData())
    expect(ids(ao).sort()).toEqual(['t1', 't2', 't3'])
    expect(ids(ao).sort()).toEqual(ids(bo).sort()) // both agree
    expect(new Set(ids(ao)).size).toBe(ids(ao).length) // NO duplicates
    expect(ao.tasks).toEqual(bo.tasks) // same content + order
  })

  it('per-field merge AFTER sync: different-field edits to the same card both survive', () => {
    // Realistic flow: both peers share the same base (they synced), THEN each
    // edits a DIFFERENT field. Only the changed key gets a new op, so both win.
    // (Pre-sync concurrent edits to the SAME field are last-writer-wins — that's
    // resolved by git rebase across sessions; not asserted here.)
    const base = sampleData()
    const t1 = base.tasks[0]
    const a = new Y.Doc()
    projectDataToBoardDoc(a, base)
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a)) // shared base (synced)
    projectDataToBoardDoc(a, { ...base, tasks: [{ ...t1, title: 'A-title' }, base.tasks[1]] })
    projectDataToBoardDoc(b, { ...base, tasks: [{ ...t1, boardColumn: 'doing' }, base.tasks[1]] })
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    const ao = boardDocToProjectData(a, base)
    const bo = boardDocToProjectData(b, base)
    expect(ao.tasks).toEqual(bo.tasks)
    expect(tById(ao, 't1').title).toBe('A-title')
    expect(tById(ao, 't1').boardColumn).toBe('doing')
  })

  it('deletion converges: a card removed on one peer is removed on the other', () => {
    const base = sampleData()
    const a = new Y.Doc()
    projectDataToBoardDoc(a, base)
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a)) // shared base
    projectDataToBoardDoc(a, { ...base, tasks: [base.tasks[0]] }) // A deletes t2
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    expect(ids(boardDocToProjectData(b, base))).toEqual(['t1'])
  })

  it('clearing an optional field converges (flat key deleted)', () => {
    const base = sampleData()
    const a = new Y.Doc()
    projectDataToBoardDoc(a, base)
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    const t2 = { ...base.tasks[1] }
    delete t2.dependsOn // t2 had dependsOn: ['t1']
    projectDataToBoardDoc(a, { ...base, tasks: [base.tasks[0], t2] })
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    expect(boardDocToProjectData(b, base).tasks.find((t) => t.id === 't2')!.dependsOn).toBeUndefined()
  })
})

describe('canvas doc mapper', () => {
  it('round-trips elements + name, ignores viewport/chats', () => {
    const file = sampleCanvas()
    const doc = new Y.Doc()
    canvasFileToDoc(doc, file)
    const out = docToCanvasFile(doc, file)
    expect(out.elements).toEqual(file.elements)
    expect(out.name).toBe(file.name)
    expect(out.viewport).toEqual(file.viewport)
    const map = doc.getMap(CANVAS_ROOT)
    expect(map.has('m:viewport')).toBe(false)
  })

  it('two INDEPENDENTLY-seeded canvases converge to the union of elements', () => {
    const a = new Y.Doc()
    canvasFileToDoc(a, sampleCanvas())
    const b = new Y.Doc()
    canvasFileToDoc(b, {
      ...sampleCanvas(),
      elements: [
        sampleCanvas().elements[0],
        { id: 'e3', type: 'sticky', x: 9, y: 9, text: 'b-only' },
      ],
    })
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    const ao = docToCanvasFile(a, sampleCanvas())
    const bo = docToCanvasFile(b, sampleCanvas())
    const eids = (f: CanvasFile) => f.elements.map((e) => e.id).sort()
    expect(eids(ao)).toEqual(['e1', 'e2', 'e3'])
    expect(eids(ao)).toEqual(eids(bo))
    expect(new Set(eids(ao)).size).toBe(eids(ao).length)
  })
})

describe('boardDoc — shared canvas index (member discovery)', () => {
  const INDEX = [
    { id: 'cv1', name: 'Wireframes' },
    { id: 'cv2', name: 'Moodboard' },
  ]

  it('write → read round-trips the canvas index', () => {
    const doc = new Y.Doc()
    writeBoardCanvasIndex(doc, INDEX)
    expect(readBoardCanvasIndex(doc)).toEqual(INDEX)
  })

  it('a Board-tab seed does NOT clobber a Canvas-tab-published index', () => {
    // The core two-writer invariant: the owner's Canvas tab publishes the index,
    // and a Board-tab full seed (which carries no canvas list) must leave it
    // intact — else the index would LWW-vanish whenever the owner views the Board.
    const doc = new Y.Doc()
    writeBoardCanvasIndex(doc, INDEX)
    projectDataToBoardDoc(doc, sampleData()) // sampleData has no canvasIndex
    expect(readBoardCanvasIndex(doc)).toEqual(INDEX)
  })

  it('a member extract (boardDocToProjectData) carries the index when set', () => {
    const doc = new Y.Doc()
    projectDataToBoardDoc(doc, sampleData())
    writeBoardCanvasIndex(doc, INDEX)
    const out = boardDocToProjectData(doc, { description: '', tasks: [], notes: '', updatedAt: '' })
    expect(out.canvasIndex).toEqual(INDEX)
  })

  it('readBoardCanvasIndex drops malformed entries (poison-resistant)', () => {
    const doc = new Y.Doc()
    const map = doc.getMap<unknown>(BOARD_ROOT)
    map.set('m:canvasIndex', [
      { id: 'ok', name: 'Good' },
      { id: 'noName' },
      { name: 'noId' },
      'junk',
      null,
      { id: 1, name: 2 },
    ])
    expect(readBoardCanvasIndex(doc)).toEqual([{ id: 'ok', name: 'Good' }])
  })

  it('independently-published indexes converge (whole-value LWW, no crash)', () => {
    const a = new Y.Doc()
    writeBoardCanvasIndex(a, [{ id: 'cv1', name: 'A' }])
    const b = new Y.Doc()
    writeBoardCanvasIndex(b, [{ id: 'cv1', name: 'A' }, { id: 'cv2', name: 'B' }])
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    // LWW resolves to one of the two whole values; both peers agree.
    expect(readBoardCanvasIndex(a)).toEqual(readBoardCanvasIndex(b))
  })
})
