// The image lines an agent writes (docs/PHONE_LINK.md "Agent images"): the Mac
// chat (parseMarkdownBlocks) and the phone (splitImageRefs) must read the very
// same lines as images, and nothing else.
import { describe, expect, it } from 'vitest'
import { imageRefOf, splitImageRefs } from './agentImage'
import { parseMarkdownBlocks } from './sdkTranscript'

describe('agent image lines', () => {
  it('only a whole line naming an absolute (or home) path is an image', () => {
    expect(imageRefOf('![画面](/tmp/a.png)')).toEqual({ alt: '画面', path: '/tmp/a.png' })
    expect(imageRefOf('  ![](~/shots/a.jpg)  ')).toEqual({ alt: '', path: '~/shots/a.jpg' })
    expect(imageRefOf('![x](</Users/me/Mobile Documents/a b.png>)')).toEqual({ alt: 'x', path: '/Users/me/Mobile Documents/a b.png' })
    for (const not of ['![x](a.png)', '![x](https://e.com/a.png)', 'see ![x](/tmp/a.png)', '![x](/tmp/a.png) here', '[x](/tmp/a.png)'])
      expect(imageRefOf(not)).toBeNull()
  })

  it('the phone and the Mac chat take the same lines out, up to four, never inside a code fence', () => {
    const text = ['できました。', '', '![1](/a/1.png)', '```', '![no](/a/x.png)', '```', '![2](/a/2.png)', '![3](/a/3.png)', '![4](/a/4.png)', '![5](/a/5.png)'].join('\n')
    const phone = splitImageRefs(text)
    const mac = parseMarkdownBlocks(text).filter((b) => b.kind === 'image').map((b) => (b.kind === 'image' ? b.path : ''))
    expect(phone.paths).toEqual(['/a/1.png', '/a/2.png', '/a/3.png', '/a/4.png'])
    expect(mac).toEqual(phone.paths)
    expect(phone.text).toBe(['できました。', '', '```', '![no](/a/x.png)', '```', '![5](/a/5.png)'].join('\n'))
  })

  it('an image line ends the paragraph above it', () => {
    expect(parseMarkdownBlocks('一行目\n![a](/a.png)\n二行目').map((b) => b.kind)).toEqual(['para', 'image', 'para'])
  })
})
