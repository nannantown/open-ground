import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import type { ProjectData, ProjectTask } from '../../types'
import {
  BOARD_ROOT,
  boardDocToProjectData,
  docSeesDisk,
  projectDataToBoardDoc,
  writeBoardCanvasIndex,
  writeBoardDiskStamp,
} from '../boardDoc'

// Regression suite for bug 74ec0b0d — "a card finalized to `done` rolls back to
// `review` on its own, with no writer in any log".
//
// THE MECHANISM. While a project is realtime-collab shared, the owner's client
// writes the Y.Doc BACK to disk on every remote doc update (BoardModule's
// onRemote → boardDocToProjectData → persist), taking the task list wholesale
// from the doc. That persist carries a FRESH CAS token, so the store's
// compare-and-swap never stops it. The server-side mirror that is supposed to
// keep the doc abreast of disk is fire-and-forget with retry backoff — and the
// swarm-board.sh app-down fallback writes tasks.json directly, skipping it
// entirely. So the doc can sit BEHIND disk for an unbounded stretch, holding the
// card's OLD column. Any remote update in that window — a peer's edit, a
// reconnect sync, or (single-client!) the owner's own Canvas tab publishing
// m:canvasIndex through a SECOND board binding — makes the client persist that
// stale list over the newer board. review comes back from the dead.
//
// THE FIX under test: the doc records the disk state its board content was
// derived from (m:diskStamp, written only by the two writers that assert disk
// truth — the server mirror and the owner's authoritative seed). The owner
// adopts doc→disk only once that stamp has caught up.

const CARD = '74ec0b0d-ee2a-49bd-8091-5a6dd4f3876a'
const T1 = '2026-07-09T01:00:00.000Z' // the disk state the doc last saw (card in review)
const T2 = '2026-07-09T01:19:00.000Z' // the finalize: setColumn done

const card = (over: Partial<ProjectTask> = {}): ProjectTask => ({
  id: CARD,
  title: 'C3 [IMPL][Phase2] 自由文質問の検出+注入',
  done: false,
  createdAt: '2026-07-06T10:21:08.000Z',
  boardColumn: 'review',
  ...over,
})

/** The owner's on-disk ProjectData at a given write stamp. */
const disk = (col: ProjectTask['boardColumn'], updatedAt: string): ProjectData => ({
  description: 'OPEN GROUND',
  tasks: [card({ boardColumn: col, done: col === 'done' })],
  notes: '',
  updatedAt,
})

const columnOf = (d: ProjectData) => d.tasks.find((t) => t.id === CARD)!.boardColumn

/** What a peer sees in the doc, independent of any disk authority (member view:
 *  no local folder ⇒ empty base stamp ⇒ the gate never applies). */
const docView = (doc: Y.Doc): ProjectData =>
  boardDocToProjectData(doc, { description: '', tasks: [], notes: '', updatedAt: '' })

/** A remote update that does NOT carry the card: exactly what the owner's Canvas
 *  tab publishes (a second board-scope binding → same room), and the trigger that
 *  turned a stale doc into a disk rollback in the field. */
const remotePeerTouchesUnrelatedKey = (doc: Y.Doc): void => {
  const peer = new Y.Doc()
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc))
  writeBoardCanvasIndex(peer, [{ id: 'cv1', name: 'Wireframes' }])
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer))
}

describe('boardDoc — disk-authority stamp (74ec0b0d: done ↛ review)', () => {
  it('THE REPRO: a doc behind disk is NOT adopted — the finalized card stays done', () => {
    // The doc learned the board when the card was still in `review` (disk @T1).
    const doc = new Y.Doc()
    projectDataToBoardDoc(doc, disk('review', T1))

    // The engine finalizes the card: disk is now `done` @T2. The mirror has not
    // landed (retry backoff / a direct tasks.json write), so the doc still says
    // `review` — assert that, so this test can't pass vacuously on an empty doc.
    const onDisk = disk('done', T2)
    expect(columnOf(docView(doc))).toBe('review')

    // A remote update arrives that says nothing about the card.
    remotePeerTouchesUnrelatedKey(doc)

    // The owner's onRemote adoption: the gate refuses. Same reference back, so
    // BoardModule skips the persist entirely (and React bails out of setState).
    const adopted = boardDocToProjectData(doc, onDisk)
    expect(adopted).toBe(onDisk)
    expect(columnOf(adopted)).toBe('done')
  })

  it('adoption RESUMES once the doc catches up with disk (no permanent stall)', () => {
    const doc = new Y.Doc()
    projectDataToBoardDoc(doc, disk('review', T1))
    const onDisk = disk('done', T2)
    expect(boardDocToProjectData(doc, onDisk)).toBe(onDisk) // gated

    // The mirror's retry lands: the doc is stamped with the disk state it now
    // reflects (this is what mirrorBoardPreserving does on the server).
    projectDataToBoardDoc(doc, onDisk)
    expect(docSeesDisk(doc, T2)).toBe(true)

    // A peer now genuinely edits the card's title. The owner adopts it — and the
    // column the disk established survives.
    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc))
    peer.getMap<unknown>(BOARD_ROOT).set(`t:${CARD}:title`, 'edited by a peer')
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer))

    const adopted = boardDocToProjectData(doc, onDisk)
    expect(adopted).not.toBe(onDisk)
    expect(columnOf(adopted)).toBe('done')
    expect(adopted.tasks[0].title).toBe('edited by a peer')
  })

  it('the stamp is MONOTONIC: an optimistic pre-PUT re-seed cannot re-open the gate', () => {
    // The owner's persistLocal seeds `next` BEFORE the PUT lands, so it still
    // carries the pre-write updatedAt. If that walked the stamp backwards, the
    // gate would open on a doc that is actually behind — the bug, restored.
    const doc = new Y.Doc()
    projectDataToBoardDoc(doc, disk('done', T2))
    projectDataToBoardDoc(doc, disk('review', T1)) // stale snapshot, old stamp
    expect(docSeesDisk(doc, T2)).toBe(true)

    // Belt and braces: the raw primitive refuses to regress, and ignores junk.
    const map = doc.getMap<unknown>(BOARD_ROOT)
    writeBoardDiskStamp(map, T1)
    writeBoardDiskStamp(map, '')
    writeBoardDiskStamp(map, 'not-a-date')
    writeBoardDiskStamp(map, undefined)
    expect(map.get('m:diskStamp')).toBe(T2)
  })

  // THE FIELD TRACE, 2026-07-09 03:54–03:56 UTC, reproduced exactly. Caught by
  // watching the room and the central tasks.json side by side:
  //   03:54:07  the mirror brings the room to `done`
  //   ~03:56    the room is `review` again (authored by a browser clientID)
  //   03:56:20  tasks.json flips done → review   ← the rollback
  // The poisoner is the owner's OPTIMISTIC seed: persistLocal seeds `next` into
  // the doc before the PUT resolves, so a snapshot the store then REFUSES (409)
  // is already burned into the authoritative doc. A monotonic stamp alone does
  // NOT save us — the stale seed leaves `review` content sitting under a `done`
  // stamp, and the gate happily opens on it. The stale seed must be REFUSED.
  it('THE POISON: a stale snapshot (the one the store 409s) cannot enter the doc', () => {
    const onDisk = disk('done', T2)
    const doc = new Y.Doc()
    projectDataToBoardDoc(doc, onDisk) // the mirror / a fresh seed: doc = done @T2

    // The client, holding a stale snapshot (review @T1), optimistically seeds it.
    projectDataToBoardDoc(doc, disk('review', T1))

    // Refused outright — the doc's CONTENT never regresses under its stamp.
    expect(columnOf(docView(doc))).toBe('done')
    expect(docSeesDisk(doc, T2)).toBe(true)

    // …so when the client's 409 makes it adopt the fresh disk state and a remote
    // update arrives, there is nothing stale to write back.
    expect(boardDocToProjectData(doc, onDisk)).toBe(onDisk)
  })

  it('a same-stamp seed still lands — a local edit must reach peers', () => {
    // The refusal is for STRICTLY older snapshots only. The owner's ordinary
    // optimistic seed carries the current disk stamp (the PUT hasn't bumped it
    // yet), and its edit must still propagate.
    const onDisk = disk('done', T2)
    const doc = new Y.Doc()
    projectDataToBoardDoc(doc, onDisk)
    const edited: ProjectData = { ...onDisk, notes: 'owner typed this' }
    projectDataToBoardDoc(doc, edited)
    expect(docView(doc).notes).toBe('owner typed this')
    expect(columnOf(docView(doc))).toBe('done')
  })

  it('a member (no disk stamp) is never refused — they hold no disk truth', () => {
    const doc = new Y.Doc()
    projectDataToBoardDoc(doc, disk('done', T2))
    // The member's seed carries updatedAt '' (SharedProjectBody's EMPTY_DATA).
    projectDataToBoardDoc(doc, {
      description: '',
      tasks: [card({ boardColumn: 'done', done: true, title: 'renamed by a member' })],
      notes: '',
      updatedAt: '',
    })
    expect(docView(doc).tasks[0].title).toBe('renamed by a member')
  })

  it('the MEMBER flow is untouched: no disk stamp on the base ⇒ always adopt', () => {
    // A member has no local folder (base.updatedAt: ''), so there is no disk
    // authority to protect — the doc is the only truth they have.
    const doc = new Y.Doc()
    projectDataToBoardDoc(doc, disk('review', T1))
    expect(docSeesDisk(doc, '')).toBe(true)
    expect(docSeesDisk(doc, undefined)).toBe(true)
    expect(columnOf(docView(doc))).toBe('review')
  })

  it('a legacy room with no stamp is gated for the owner, then healed by the seed', () => {
    // Rooms created before this fix carry no m:diskStamp. Refusing to adopt is
    // the safe direction; the owner's mount seed stamps it immediately.
    const doc = new Y.Doc()
    const map = doc.getMap<unknown>(BOARD_ROOT)
    doc.transact(() => {
      map.set(`t:${CARD}:boardColumn`, 'review')
      map.set('m:order', [CARD])
    })
    const onDisk = disk('done', T2)
    expect(docSeesDisk(doc, T2)).toBe(false)
    expect(boardDocToProjectData(doc, onDisk)).toBe(onDisk)

    projectDataToBoardDoc(doc, onDisk) // the owner's authoritative seed
    expect(docSeesDisk(doc, T2)).toBe(true)
    expect(columnOf(docView(doc))).toBe('done')
  })

  it('second-precision stamps (swarm-board.sh writes them) compare by time, not bytes', () => {
    // '…T01:19:00Z' sorts AFTER '…T01:19:00.500Z' lexically but is EARLIER in
    // time — a byte comparison would open the gate on a stale doc.
    const doc = new Y.Doc()
    projectDataToBoardDoc(doc, disk('review', '2026-07-09T01:19:00Z'))
    expect(docSeesDisk(doc, '2026-07-09T01:19:00.500Z')).toBe(false)
    // The doc's own coarse stamp, offered back verbatim, is exact proof.
    expect(docSeesDisk(doc, '2026-07-09T01:19:00Z')).toBe(true)
  })

  // ── The two precisions, and the wall-second they share ─────────────────────
  //
  // The server mints millisecond stamps; `swarm-board.sh` writes
  // `now | todateiso8601`, TRUNCATED to the second. A shell write at real
  // 01:19:00.85 therefore stamps 01:19:00.000 — numerically SMALLER than a server
  // stamp of 01:19:00.800 that happened EARLIER. Comparing stamps as values
  // inverts real time inside that second, and the inversion is not academic: the
  // sub-second part of a server stamp is ~uniform, so a same-second collision
  // lands on the wrong side most of the time.
  describe('a second-precision writer sharing the doc’s wall-second', () => {
    const MIRRORED = '2026-07-09T01:19:00.800Z' // room's last server mirror (review)
    const SHELL = '2026-07-09T01:19:00Z' //        shell wrote `done` at real .85

    /** The room as the app-down window left it: `review`, stamped by the mirror. */
    const poisonedRoom = (): Y.Doc => {
      const doc = new Y.Doc()
      projectDataToBoardDoc(doc, disk('review', MIRRORED))
      return doc
    }

    it('THE INVERSION: the gate must NOT open for a coarse stamp in the same second', () => {
      // 0.800 >= 0.000 as VALUES ⇒ "caught up" ⇒ the room's `review` gets written
      // over the `done` on disk. As INTERVALS, 0.800 does not reach 0.999, so the
      // doc cannot prove it saw the shell's write, and the gate stays shut.
      const doc = poisonedRoom()
      expect(docSeesDisk(doc, SHELL)).toBe(false)

      const onDisk = disk('done', SHELL)
      expect(boardDocToProjectData(doc, onDisk)).toBe(onDisk) // no rollback
      expect(columnOf(boardDocToProjectData(doc, onDisk))).toBe('done')
    })

    it('the owner’s mount seed of that disk state is NOT refused as stale', () => {
      // Symmetric half: refusing it would strand the room on `review` forever.
      // `done`@.000 might be the NEWER write, so it is allowed to land; only the
      // gate above stays conservative.
      const doc = poisonedRoom()
      projectDataToBoardDoc(doc, disk('done', SHELL))
      expect(columnOf(docView(doc))).toBe('done')
    })

    it('a coarse stamp from an EARLIER second is still provably older (seed refused)', () => {
      // 01:18:59.999 (its latest instant) precedes 01:19:00.800 — no overlap, so
      // the conservative reading and the strict one agree: this seed is stale.
      const doc = poisonedRoom()
      projectDataToBoardDoc(doc, disk('todo', '2026-07-09T01:18:59Z'))
      expect(columnOf(docView(doc))).toBe('review')
    })

    it('a server stamp past the coarse second DOES open the gate', () => {
      const doc = new Y.Doc()
      projectDataToBoardDoc(doc, disk('review', SHELL)) // doc stamped coarse
      expect(docSeesDisk(doc, '2026-07-09T01:19:00.500Z')).toBe(false) // inside the second
      // Once the mirror lands a stamp that covers the whole second, adoption resumes.
      projectDataToBoardDoc(doc, disk('done', '2026-07-09T01:19:01.000Z'))
      expect(docSeesDisk(doc, '2026-07-09T01:19:01.000Z')).toBe(true)
    })
  })

  it('the gate does not fire on the happy path (doc and disk in step)', () => {
    const onDisk = disk('done', T2)
    const doc = new Y.Doc()
    projectDataToBoardDoc(doc, onDisk)
    // Equal stamps ⇒ the doc has seen this exact disk state ⇒ the gate is open.
    expect(docSeesDisk(doc, T2)).toBe(true)
    // Content is identical, so there is nothing to adopt (echo): base identity.
    expect(boardDocToProjectData(doc, onDisk)).toBe(onDisk)
    // A real peer change on the open gate IS adopted.
    doc.getMap<unknown>(BOARD_ROOT).set('m:notes', 'peer notes')
    const adopted = boardDocToProjectData(doc, onDisk)
    expect(adopted).not.toBe(onDisk)
    expect(adopted.notes).toBe('peer notes')
    expect(columnOf(adopted)).toBe('done')
  })

  // THE LOOP GUARD, relocated. The mirror must stamp EVERY disk write (or the
  // gate above never re-opens), so a content-identical write now does emit one
  // doc update — which reaches the owner as a remote change. Without an echo
  // check the owner would answer it with a content-identical PUT, whose write
  // would mirror, whose stamp would emit another update: a ping-pong at the
  // debounce cadence. `boardDocToProjectData` returning base identity is what
  // stops it dead.
  it('an ECHO (doc content already equals disk) adopts nothing — no persist, no loop', () => {
    const onDisk = disk('done', T2)
    const doc = new Y.Doc()
    projectDataToBoardDoc(doc, onDisk)

    // The mirror re-runs for a LATER disk write whose board content is identical
    // (e.g. only `notes` on another surface changed, or the owner re-saved).
    const later: ProjectData = { ...onDisk, updatedAt: '2026-07-09T02:00:00.000Z' }
    projectDataToBoardDoc(doc, later)
    expect(docSeesDisk(doc, later.updatedAt)).toBe(true) // stamp advanced

    // Owner's onRemote: identity back ⇒ BoardModule skips persistLocal entirely.
    expect(boardDocToProjectData(doc, later)).toBe(later)
  })

  it('an echo is judged structurally — task key order is not a change', () => {
    // The doc rebuilds each task from flat keys, so its field ORDER differs from
    // the disk JSON. A stringly comparison would call that a change and PUT on
    // every mirror stamp; jsonEqual sees through it.
    const onDisk = disk('done', T2)
    const doc = new Y.Doc()
    projectDataToBoardDoc(doc, onDisk)
    const reordered: ProjectData = {
      ...onDisk,
      tasks: [
        {
          boardColumn: 'done',
          done: true,
          createdAt: onDisk.tasks[0].createdAt,
          title: onDisk.tasks[0].title,
          id: CARD,
        } as ProjectTask,
      ],
    }
    expect(JSON.stringify(reordered.tasks)).not.toBe(JSON.stringify(onDisk.tasks))
    expect(boardDocToProjectData(doc, reordered)).toBe(reordered)
  })
})
