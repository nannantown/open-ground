import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { chatGptAuthorizationUrl } from '@/components/canvas/ChatGptSetting'

describe('official ChatGPT browser sign-in boundary', () => {
  const source = readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8')
  const functionSource = source.match(/function isAllowedOauthUrl\(url\) \{[\s\S]+?\n\}/)?.[0]
  if (!functionSource) throw new Error('native OAuth allowlist function missing')
  const native = vm.runInNewContext(`(${functionSource})`, { URL }) as (url: string) => boolean
  it('opens the official authorize URL through renderer and native boundaries', () => {
    const url = 'https://auth.openai.com/api/accounts/authorize?state=opaque&code_challenge=opaque'
    expect(chatGptAuthorizationUrl(url)).toBe(url)
    expect(native(url)).toBe(true)
  })
  it('rejects lookalike hosts, alternate protocols, userinfo, ports and paths', () => {
    for (const url of ['https://auth.openai.com.evil.test/api/accounts/authorize', 'http://auth.openai.com/api/accounts/authorize', 'https://user@auth.openai.com/api/accounts/authorize', 'https://auth.openai.com:444/api/accounts/authorize', 'https://auth.openai.com/api/accounts/oauth/token', 'javascript:alert(1)']) {
      expect(chatGptAuthorizationUrl(url), url).toBeNull()
      expect(native(url), url).toBe(false)
    }
  })
})
