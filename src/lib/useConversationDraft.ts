import { readConversationPhoto, validConversationPhoto, writeConversationPhoto } from './conversationAttachments'
import { createContext, useContext, useMemo, useSyncExternalStore, type SetStateAction, useEffect } from 'react'

/** The signed-in app owner, never a preview/display role or provider account. */
export const ConversationDraftOwnerContext = createContext<string | null>(null)
export interface ConversationDraftRecord { revision: number; text: string; updatedAt: string }
export interface ConversationSend {
  ownerId?: string
  photoKey?: string
  clientId: string
  draftClientId: string
  draftRevision: number
  editRevision: number
  text: string
}
export interface ConversationReceiptView { id: string; state: string; text: string }
interface PresidentCancellation { path: string; operationId: string; conversationId: string; epoch: number; messageIds: string[]; note: string }
const unresolved = (state: string) => !['delivered', 'completed', 'replied', 'rejected', 'cancelled'].includes(state)
interface Snapshot {
  receipts: ConversationReceiptView[]
  photo: string | null
  photoSaving: boolean
  photoError: string | null
  text: string
  revision: number
  editRevision: number
  loaded: boolean
  saving: boolean
  dirty: boolean
  error: string | null
  attempt: ConversationSend | null
}
const EMPTY: Snapshot = { receipts: [], photo: null, photoSaving: false, photoError: null, text: '', revision: 0, editRevision: 0, loaded: false, saving: false, dirty: false, error: null, attempt: null }
const idleSubscribe = () => () => {}
const emptySnapshot = () => EMPTY
const controllers = new Map<string, DraftController>()
const ORIGIN_KEY = 'openground:conversation-origin'
const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
const record = (value: unknown): value is ConversationDraftRecord => {
  if (!value || typeof value !== 'object') return false
  const r = value as ConversationDraftRecord
  return Number.isSafeInteger(r.revision) && r.revision >= 0 && typeof r.text === 'string' && r.text.length <= 32_768 && typeof r.updatedAt === 'string'
}
export const conversationOriginId = (): string => {
  const saved = localStorage.getItem(ORIGIN_KEY)
  if (validId(saved)) return saved
  const id = crypto.randomUUID()
  localStorage.setItem(ORIGIN_KEY, id)
  return id
}

/** Server CAS is authoritative; the owner-scoped mirror recovers keystrokes
 *  and request identities which had not reached their acknowledgement yet. */
class DraftController {
  private state: Snapshot = { ...EMPTY }
  private listeners = new Set<() => void>()
  private writer: Promise<void> = Promise.resolve()
  private loading: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  readonly originId: string
  private readonly key: string
  private readonly url: string
  private storageReady = true
  private photoKey: string | null = null
  private photoWriter: Promise<void> = Promise.resolve()
  private abort = new AbortController()
  constructor(private readonly owner: string, readonly scope: string) {
    try { this.originId = conversationOriginId() } catch { this.originId = crypto.randomUUID(); this.storageReady = false; this.state.error = 'draft-local-write-failed' }
    this.key = `openground:conversation-draft:${encodeURIComponent(owner)}:${scope}`
    this.url = `/api/conversation/draft?scope=${encodeURIComponent(scope)}&clientId=${encodeURIComponent(this.originId)}`
    try {
      const raw = localStorage.getItem(this.key)
      const saved = raw && raw.length < 256_000 ? JSON.parse(raw) as Partial<Snapshot> & { photoKey?: string } : null
      if (saved && typeof saved.text === 'string' && saved.text.length <= 32_768 && Number.isSafeInteger(saved.revision) && Number.isSafeInteger(saved.editRevision)) {
        this.photoKey = typeof saved.photoKey === 'string' && saved.photoKey.startsWith(this.key + ':photo:') ? saved.photoKey : null
        const attempt = saved.attempt
        this.state = { ...EMPTY, receipts: Array.isArray(saved.receipts) ? saved.receipts.filter(r => validId(r.id) && typeof r.state === 'string' && typeof r.text === 'string').slice(0, 64).map(r => ({ ...r, text: r.text.slice(0, 1000) })) : [], text: saved.text, revision: saved.revision!, editRevision: saved.editRevision!, dirty: saved.dirty === true,
          attempt: attempt && validId(attempt.clientId) && attempt.draftClientId === this.originId && Number.isSafeInteger(attempt.draftRevision) && Number.isSafeInteger(attempt.editRevision) && typeof attempt.text === 'string' ? attempt : null }
      }
    } catch { this.state = { ...this.state, error: 'draft-recovery-failed' } }
  }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    if (this.abort.signal.aborted) this.abort = new AbortController()
    this.listeners.add(listener); void this.load().catch(() => {})
    if (this.state.dirty && !this.state.attempt) this.schedule()
    return () => { this.listeners.delete(listener); if (!this.listeners.size) { clearTimeout(this.timer); this.abort.abort() } }
  }
  private update(patch: Partial<Snapshot>) {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach(listener => listener())
  }
  private persist() {
    localStorage.setItem(this.key, JSON.stringify({ text: this.state.text, revision: this.state.revision, editRevision: this.state.editRevision, dirty: this.state.dirty, attempt: this.state.attempt, receipts: this.state.receipts, photoKey: this.photoKey }))
  }
  private async read(): Promise<ConversationDraftRecord> {
    const response = await fetch(this.url, { cache: 'no-store', signal: this.abort.signal, headers: { 'X-OpenGround-Owner': this.owner } })
    if (!response.ok) throw new Error('draft-read-failed')
    const next: unknown = await response.json()
    if (!record(next)) throw new Error('draft-read-failed')
    return next
  }
  load = async (): Promise<void> => {
    if (!this.storageReady) throw new Error('draft-local-write-failed')
    if (this.state.loaded) return
    if (this.loading) return this.loading
    this.loading = (async () => {
      try {
        const next = await this.read()
        // An unacknowledged operation must be resolved with its SAME ID. Its
        // server draft may already have been cleared by durable acceptance.
        if (this.state.attempt) { this.update({ revision: next.revision, loaded: true, error: 'delivery-unconfirmed' }); await this.recover() }
        else if (this.state.dirty && next.text !== this.state.text && next.revision > this.state.revision) this.update({ loaded: true, error: 'draft-conflict' })
        else if (this.state.dirty && next.text !== this.state.text) this.update({ revision: next.revision, loaded: true })
        else this.update({ text: next.text, revision: next.revision, loaded: true, dirty: false, error: null })
        if (this.photoKey) {
          try { this.update({ photo: await readConversationPhoto(this.photoKey), photoError: null }) }
          catch { this.update({ photoError: 'photo-recovery-failed' }); throw new Error('photo-recovery-failed') }
        }
        this.persist()
        if (this.state.dirty && !this.state.error) this.schedule()
      } catch (error) { this.update({ error: error instanceof Error ? error.message : 'draft-read-failed' }); throw error }
      finally { this.loading = null }
    })()
    return this.loading
  }
  setText = (value: SetStateAction<string>) => {
    const text = typeof value === 'function' ? value(this.state.text) : value
    if (text.length > 32_768 || text === this.state.text) return
    this.update({ text, editRevision: this.state.editRevision + 1, dirty: true, error: this.state.error === 'draft-conflict' ? 'draft-conflict' : null })
    try { this.persist() } catch { this.update({ error: 'draft-local-write-failed' }) }
    this.schedule()
  }
  setPhoto = (value: SetStateAction<string | null>) => {
    const photo = typeof value === 'function' ? value(this.state.photo) : value
    if (photo !== null && !validConversationPhoto(photo)) { this.update({ photoError: 'photo-save-failed' }); return }
    const previous = this.photoKey
    const key = photo ? `${this.key}:photo:${crypto.randomUUID()}` : null
    this.photoKey = key
    this.update({ photo, photoSaving: !!photo, photoError: null, editRevision: this.state.editRevision + 1, error: null })
    try { this.persist() } catch { this.update({ error: 'draft-local-write-failed' }) }
    const work = this.photoWriter.catch(() => {}).then(async () => {
      if (key && photo) await writeConversationPhoto(key, photo)
      if (previous && previous !== this.state.attempt?.photoKey) await writeConversationPhoto(previous, null)
    })
    this.photoWriter = work
    void work.then(() => { if (this.photoKey === key) this.update({ photoSaving: false }) }, () => { if (this.photoKey === key) this.update({ photoSaving: false, photoError: 'photo-save-failed' }) })
  }
  photoForSend = async (attempt: ConversationSend): Promise<string | undefined> => attempt.photoKey ? readConversationPhoto(attempt.photoKey) : undefined
  private schedule() {
    clearTimeout(this.timer)
    if (this.state.attempt || !this.listeners.size) return
    this.timer = setTimeout(() => { void this.flush().catch(() => {}) }, 150)
  }
  flush = async (): Promise<ConversationDraftRecord> => {
    clearTimeout(this.timer)
    await this.load()
    const work = this.writer.then(async () => {
      if (this.state.attempt) return
      if (this.state.error === 'draft-conflict') throw new Error('draft-conflict')
      while (this.state.dirty) {
        const { revision, text, editRevision } = this.state
        this.update({ saving: true })
        const response = await fetch(this.url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-OpenGround-Owner': this.owner }, signal: this.abort.signal, body: JSON.stringify({ revision, text }) })
        if (response.status === 409) { this.update({ error: 'draft-conflict' }); throw new Error('draft-conflict') }
        if (!response.ok) throw new Error('draft-save-failed')
        const next: unknown = await response.json()
        if (!record(next)) throw new Error('draft-save-failed')
        this.update({ revision: next.revision, dirty: this.state.editRevision !== editRevision, error: null })
        this.persist()
      }
    }).catch(error => { this.update({ error: error instanceof Error ? error.message : 'draft-save-failed' }); throw error }).finally(() => this.update({ saving: false }))
    this.writer = work.catch(() => {})
    await work
    return { revision: this.state.revision, text: this.state.text, updatedAt: '' }
  }
  prepareSend = async (): Promise<ConversationSend> => {
    if (this.state.attempt) {
      return { ...this.state.attempt, ownerId: this.owner }
    }
    if (this.state.receipts.filter(r => unresolved(r.state)).length >= 64) { this.update({ error: 'pending-capacity' }); throw new Error('pending-capacity') }
    try { await this.photoWriter } catch { this.update({ photoError: 'photo-save-failed' }); throw new Error('photo-save-failed') }
    if (this.state.photoError) throw new Error(this.state.photoError)
    const saved = await this.flush()
    const attempt: ConversationSend = { ownerId: this.owner, ...(this.photoKey ? { photoKey: this.photoKey } : {}), clientId: crypto.randomUUID(), draftClientId: this.originId, draftRevision: saved.revision, editRevision: this.state.editRevision, text: saved.text }
    this.update({ attempt })
    try { this.persist() } catch { this.update({ attempt: null, error: 'draft-local-write-failed' }); throw new Error('draft-local-write-failed') }
    return attempt
  }
  accepted = async (attempt: ConversationSend, receipt?: { id?: string; state?: string }): Promise<void> => {
    if (this.state.attempt?.clientId !== attempt.clientId) return
    // Revision identity protects a newer edit, even an identical retyped line.
    if (this.state.editRevision === attempt.editRevision) { this.photoKey = null; this.update({ photo: null, text: '', editRevision: this.state.editRevision + 1, dirty: false }) }
    const accepted: ConversationReceiptView = { id: attempt.clientId, state: receipt?.id === attempt.clientId && typeof receipt.state === 'string' ? receipt.state : 'queued', text: attempt.text.slice(0, 1000) }
    const kept = this.state.receipts.filter(r => r.id !== accepted.id)
    this.update({ receipts: [...kept.filter(r => unresolved(r.state)), ...kept.filter(r => !unresolved(r.state)).slice(-9), accepted], attempt: null, error: null })
    this.persist()
    const work = this.writer.then(async () => {
      const next = await this.read()
      this.update({ revision: next.revision })
      if (!this.state.dirty && next.text === '') this.update({ text: '' })
      this.persist()
    })
    this.writer = work.catch(() => {})
    try { await work; if (attempt.photoKey && attempt.photoKey !== this.photoKey) await writeConversationPhoto(attempt.photoKey, null); if (this.state.dirty) this.schedule() }
    catch { this.update({ error: 'draft-read-failed' }) }
  }

  recover = async (): Promise<boolean> => {
    const attempt = this.state.attempt
    if (!attempt) return true
    const response = await fetch(`/api/conversation/receipt?scope=${encodeURIComponent(this.scope)}&clientId=${encodeURIComponent(attempt.clientId)}`, { cache: 'no-store', signal: this.abort.signal, headers: { 'X-OpenGround-Owner': this.owner } })
    if (response.status === 404) return false
    if (!response.ok) throw new Error('delivery-unconfirmed')
    const receipt = await response.json() as { state?: string; id?: string }
    if (receipt.id !== attempt.clientId || !['queued', 'executing', 'delivered', 'rejected', 'uncertain', 'cancelled', 'replying', 'replied', 'interrupted', 'running', 'completed', 'failed'].includes(receipt.state ?? '')) throw new Error('delivery-unconfirmed')
    if (receipt.state === 'rejected' || receipt.state === 'cancelled') this.refused(attempt)
    else await this.accepted(attempt, receipt)
    return true
  }
  recoverReceipts = async (): Promise<void> => {
    for (const previous of this.state.receipts.filter(r => unresolved(r.state))) {
      const response = await fetch(`/api/conversation/receipt?scope=${encodeURIComponent(this.scope)}&clientId=${encodeURIComponent(previous.id)}`, { cache: 'no-store', signal: this.abort.signal, headers: { 'X-OpenGround-Owner': this.owner } })
      if (!response.ok) continue
      const next = await response.json() as { id?: string; state?: string }
      if (next.id === previous.id && typeof next.state === 'string') this.update({ receipts: this.state.receipts.map(r => r.id === previous.id && unresolved(r.state) ? { ...r, state: next.state! } : r) })
    }
    this.persist()
  }
  cancelReceipt = async (projectPath: string, id: string, note: string): Promise<void> => {
    if (this.scope === 'assistant' || !validId(id) || !this.state.receipts.some(r => r.id === id)) throw new Error('cancellation-unavailable')
    const key = `${this.key}:cancel:${id}`
    const headers = { 'Content-Type': 'application/json', 'X-OpenGround-Owner': this.owner }
    const saved = localStorage.getItem(key)
    let operation: PresidentCancellation
    if (saved) {
      const value = JSON.parse(saved) as PresidentCancellation
      if (value.path !== projectPath || !validId(value.operationId) || value.operationId.length > 100 || !validId(value.conversationId)
        || !Number.isSafeInteger(value.epoch) || value.epoch < 0 || !Array.isArray(value.messageIds) || value.messageIds.length !== 1 || value.messageIds[0] !== id
        || typeof value.note !== 'string' || !value.note.trim() || value.note.length > 1000) throw new Error('cancellation-unavailable')
      operation = value
    } else {
      const statusResponse = await fetch(`/api/conversation/president/status?path=${encodeURIComponent(projectPath)}`, { cache: 'no-store', headers })
      if (!statusResponse.ok) throw new Error('cancellation-unavailable')
      const status = await statusResponse.json() as { state?: string; conversationId?: string; epoch?: number; capabilities?: { cancelPresidentInputs?: number } }
      if (status.state !== 'delivered' || status.capabilities?.cancelPresidentInputs !== 1 || !validId(status.conversationId)
        || !Number.isSafeInteger(status.epoch) || status.epoch! < 0 || !note.trim() || note.length > 1000) throw new Error('cancellation-unavailable')
      operation = { path: projectPath, operationId: crypto.randomUUID(), conversationId: status.conversationId, epoch: status.epoch!, messageIds: [id], note }
      // A lost acknowledgement must retry the same cancellation, never a new command.
      localStorage.setItem(key, JSON.stringify(operation))
    }
    const response = await fetch('/api/conversation/president/cancel-inputs', { method: 'POST', headers, body: JSON.stringify(operation) })
    if (!response.ok) throw new Error('cancellation-unconfirmed')
    const result = await response.json() as { ok?: boolean; receipts?: { id?: string; state?: string }[] }
    if (!result.ok || result.receipts?.length !== 1 || result.receipts[0].id !== id || result.receipts[0].state !== 'cancelled') throw new Error('cancellation-unconfirmed')
    this.update({ receipts: this.state.receipts.map(r => r.id === id ? { ...r, state: 'cancelled' } : r) })
    this.persist()
    localStorage.removeItem(key)
  }
  resolveConflict = async (keepLocal: boolean): Promise<void> => {
    const next = await this.read()
    this.update({ revision: next.revision, ...(keepLocal ? { dirty: true } : { text: next.text, editRevision: this.state.editRevision + 1, dirty: false }), error: null })
    this.persist()
    if (keepLocal) await this.flush()
  }
  dispose = () => { clearTimeout(this.timer); this.abort.abort(); this.listeners.clear() }
  /** Server refusal is definitive; a network loss keeps the request identity. */
  refused = (attempt: ConversationSend) => {
    if (this.state.attempt?.clientId !== attempt.clientId) return
    this.update({ attempt: null, error: null })
    this.persist()
  }
}

export const useConversationDraft = (scope: string) => {
  const owner = useContext(ConversationDraftOwnerContext)
  const controller = useMemo(() => {
    if (!owner || !validId(scope)) return null
    const key = `${owner}:${scope}`
    let draft = controllers.get(key)
    if (!draft) { draft = new DraftController(owner, scope); controllers.set(key, draft) }
    return draft
  }, [owner, scope])
  const state = useSyncExternalStore(controller?.subscribe ?? idleSubscribe, controller?.getSnapshot ?? emptySnapshot, emptySnapshot)
  useEffect(() => {
    if (!controller || !state.receipts.some(r => unresolved(r.state))) return
    const timer = setInterval(() => void controller.recoverReceipts().catch(() => {}), 2000)
    return () => clearInterval(timer)
  }, [controller, state.receipts])
  return { enabled: !!controller, ...state, setText: controller?.setText, setPhoto: controller?.setPhoto, photoForSend: controller?.photoForSend, prepareSend: controller?.prepareSend, accepted: controller?.accepted, refused: controller?.refused, flush: controller?.flush, recover: controller?.recover, cancelReceipt: controller?.cancelReceipt, resolveConflict: controller?.resolveConflict }
}

/** Only resets client test fixtures; production never discards a draft here. */
export const resetConversationDraftControllersForTests = () => { controllers.forEach(controller => controller.dispose()); controllers.clear() }
