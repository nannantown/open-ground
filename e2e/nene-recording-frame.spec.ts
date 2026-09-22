import { test, expect } from '@playwright/test'
import { createAndImportProject } from './fixtures/helpers'

test.use({ launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } })
const ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'

test('NENE gets a real microphone-capable origin without weakening arbitrary tabs', async ({ page, request }) => {
  const project = await createAndImportProject(request, 'nene-input')
  await page.route('**/api/experiments', route => route.fulfill({ json: { eligible: true, flags: {}, swarmOptIn: { available: true, enabled: false } } }))
  await page.route('**/api/custom-modules', route => route.fulfill({ json: {
    role: 'owner', modules: [{ id: ID, label: 'Songs', framework: 'html', localApp: 'nene-songs', createdAt: '', updatedAt: '' }],
  } }))
  await page.route(`**/api/custom-modules/${ID}/source`, route => route.fulfill({ json: { source: '<h1>Launcher</h1>', mtimeMs: 1, framework: 'html' } }))
  // Every NENE request is fulfilled in-memory. Never visits the owner's server.
  await page.route('http://127.0.0.1:8899/**', route => route.fulfill({
    headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'text/html',
    body: `<button id="capture">Capture synthetic input</button><output id="result"></output><output id="keys"></output>
      <script>
      document.querySelector('#capture').onclick = async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({audio:true});
          const track = stream.getAudioTracks()[0];
          document.querySelector('#result').textContent = track.readyState;
          stream.getTracks().forEach(t => t.stop());
        } catch(e) { document.querySelector('#result').textContent = e.name; }
      };
      addEventListener('message', e => { if (e.data.type === 'nene-key') document.querySelector('#keys').textContent += e.data.code; });
      </script>`,
  }))
  await page.addInitScript(id => {
    localStorage.setItem('openground:onboarded', '1')
    localStorage.setItem('openground.view', JSON.stringify({ projectId: id, panelTab: 'board' }))
  }, project.id)
  await page.goto('/')
  await page.getByRole('button', { name: 'Add tab', exact: true }).click()
  await page.getByRole('dialog', { name: 'Add a tab to this project' }).getByText('Songs', { exact: true }).click()
  const frame = page.frameLocator('iframe[title="Songs"]')
  await frame.locator('#capture').click()
  await expect(frame.locator('#result')).toHaveText('live')
  const element = page.locator('iframe[title="Songs"]')
  await expect(element).toHaveAttribute('src', 'http://127.0.0.1:8899/')
  expect(await element.getAttribute('srcdoc')).toBeNull()
  await page.locator('body').evaluate(body => { body.tabIndex = -1; body.focus() })
  await page.keyboard.press('Space')
  await expect(frame.locator('#keys')).toHaveText('Space')
  await page.keyboard.press('Enter')
  await expect(frame.locator('#keys')).toHaveText('SpaceEnter')
})
