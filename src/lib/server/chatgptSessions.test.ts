import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
const mock = vi.hoisted(() => ({ account: 'synthetic-session-account' }))
vi.mock('./chatgptAuth', async (original) => ({ ...(await original<typeof import('./chatgptAuth')>()), getChatGptAccountKey: async () => mock.account }))
import { addProjectEntry, __resetMigrationCacheForTests } from './registry'
import { setSettings } from './store'
import { claudeDirName } from './claudeProjectDir'
import { projectDataFile } from './projectDataPath'
import { ChatGptConversation, chatGptConversationFile } from './chatgptResponses'
import { SWARM_SESSIONS_FILE, recordSwarmSession, readSwarmSessions, resolveSwarmSession, forgetSwarmSessionIf } from './swarmSessions'

const CLAUDE_MANAGER = '11111111-1111-4111-8111-111111111111'
const CLAUDE_SUPPLY = '22222222-2222-4222-8222-222222222222'
const GPT_MANAGER = 'chatgpt-33333333-3333-4333-8333-333333333333'
const GPT_SUPPLY = 'chatgpt-44444444-4444-4444-8444-444444444444'
let scratch: string, project: string, home: string
let priorHome: string | undefined
const idle = { isLive: () => false, awaitRelease: async () => {} }
const response = () => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', model: 'synthetic-session-model', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A synthetic saved answer.' }] }] } })}\n\n`)
const saveChatGptTranscript = async (id: string) => {
  const conversation = new ChatGptConversation({ id, cwd: project, model: 'synthetic-session-model', tools: [], fetch: (async () => response()) as typeof fetch, accessToken: async () => 'synthetic-test-token', accountKey: async () => mock.account })
  await conversation.run('A synthetic saved question.')
  conversation.close()
}
const saveClaudeTranscript = async (id: string) => {
  const directory = join(home, '.claude', 'projects', claudeDirName(project))
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `${id}.jsonl`), JSON.stringify({ type: 'system', subtype: 'init', sessionId: id, model: 'synthetic-claude-model' }) + '\n')
}
beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-chatgpt-sessions-')))
  project = join(scratch, 'project'); home = join(scratch, 'user-home')
  await mkdir(project); await mkdir(home)
  priorHome = process.env.HOME; process.env.HOME = home
  mock.account = 'synthetic-session-account'; __resetMigrationCacheForTests()
  await setSettings({ projects: [] }); await addProjectEntry(project)
})
afterEach(async () => {
  if (priorHome !== undefined) process.env.HOME = priorHome
  __resetMigrationCacheForTests()
  await rm(scratch, { recursive: true, force: true })
})

describe('provider-specific long-lived desk slots', () => {
  it('records all four role/provider conversations without one overwriting another, then resumes the selected provider', async () => {
    await Promise.all([
      recordSwarmSession(project, 'manager', CLAUDE_MANAGER), recordSwarmSession(project, 'supply', CLAUDE_SUPPLY),
      recordSwarmSession(project, 'manager', GPT_MANAGER), recordSwarmSession(project, 'supply', GPT_SUPPLY),
    ])
    await Promise.all([saveClaudeTranscript(CLAUDE_MANAGER), saveClaudeTranscript(CLAUDE_SUPPLY), saveChatGptTranscript(GPT_MANAGER), saveChatGptTranscript(GPT_SUPPLY)])
    const disk = JSON.parse(await readFile(await projectDataFile(project, SWARM_SESSIONS_FILE), 'utf8'))
    expect(disk).toMatchObject({ manager: { sessionId: CLAUDE_MANAGER }, supply: { sessionId: CLAUDE_SUPPLY }, chatgpt: { manager: { sessionId: GPT_MANAGER }, supply: { sessionId: GPT_SUPPLY } } })
    expect(await resolveSwarmSession(project, 'manager', idle)).toMatchObject({ resume: true, agentSessionId: CLAUDE_MANAGER })
    expect(await resolveSwarmSession(project, 'supply', idle)).toMatchObject({ resume: true, agentSessionId: CLAUDE_SUPPLY })
    expect(await resolveSwarmSession(project, 'manager', { ...idle, provider: 'chatgpt' })).toMatchObject({ resume: true, agentSessionId: GPT_MANAGER })
    expect(await resolveSwarmSession(project, 'supply', { ...idle, provider: 'chatgpt' })).toMatchObject({ resume: true, agentSessionId: GPT_SUPPLY })
  })
  it('a provider with no recorded conversation starts fresh without reusing the other provider', async () => {
    await recordSwarmSession(project, 'manager', CLAUDE_MANAGER); await saveClaudeTranscript(CLAUDE_MANAGER)
    const next = await resolveSwarmSession(project, 'manager', { ...idle, provider: 'chatgpt' })
    expect(next).toMatchObject({ resume: false, reason: 'none' })
    expect(next.agentSessionId).toMatch(/^chatgpt-/)
    expect(next.agentSessionId).not.toBe(CLAUDE_MANAGER)
    expect((await readSwarmSessions(project)).manager?.sessionId).toBe(CLAUDE_MANAGER)
  })
  it('forgetting a failed ChatGPT conversation preserves the Claude slot and the other role', async () => {
    await recordSwarmSession(project, 'manager', CLAUDE_MANAGER)
    await recordSwarmSession(project, 'manager', GPT_MANAGER)
    await recordSwarmSession(project, 'supply', GPT_SUPPLY)
    expect(await forgetSwarmSessionIf(project, 'manager', GPT_MANAGER)).toBe(true)
    const disk = await readSwarmSessions(project)
    expect(disk.manager?.sessionId).toBe(CLAUDE_MANAGER)
    expect(disk.chatgpt?.manager).toBeUndefined()
    expect(disk.chatgpt?.supply?.sessionId).toBe(GPT_SUPPLY)
  })
  it('an account switch refuses the old ChatGPT history while preserving the stored file and Claude session', async () => {
    await recordSwarmSession(project, 'manager', CLAUDE_MANAGER); await saveClaudeTranscript(CLAUDE_MANAGER)
    await recordSwarmSession(project, 'manager', GPT_MANAGER); await saveChatGptTranscript(GPT_MANAGER)
    const savedHistory = await readFile(chatGptConversationFile(GPT_MANAGER), 'utf8')
    mock.account = 'a-different-synthetic-account'
    await expect(resolveSwarmSession(project, 'manager', { ...idle, provider: 'chatgpt' })).rejects.toThrow(/uncertain|invalid history/)
    expect(await readFile(chatGptConversationFile(GPT_MANAGER), 'utf8')).toBe(savedHistory)
    expect((await readSwarmSessions(project)).chatgpt?.manager?.sessionId).toBe(GPT_MANAGER)
    expect(await resolveSwarmSession(project, 'manager', idle)).toMatchObject({ resume: true, agentSessionId: CLAUDE_MANAGER })
  })
})
