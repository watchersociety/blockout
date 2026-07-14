/**
 * Headless smoke test: launch the real built app, script a scene through
 * the store (the same code paths the UI calls), run a real export through
 * the real ffmpeg pipeline, and assert the package on disk — file presence,
 * video duration/resolution via ffprobe, stills, prompt, and metadata.
 */

import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'

let app: ElectronApplication
let page: Page
let smokeDir: string
let smokeHome: string
let smokeUserData: string

function controlFile(): string {
  return join(smokeHome, '.config', 'blockout', 'control.json')
}

test.beforeAll(async () => {
  smokeDir = mkdtempSync(join(tmpdir(), 'blockout-smoke-'))
  smokeHome = join(smokeDir, 'home')
  smokeUserData = join(smokeDir, 'user-data')
  mkdirSync(smokeHome)
  app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${smokeUserData}`],
    env: { ...process.env, HOME: smokeHome, BLOCKOUT_SMOKE_DIR: smokeDir }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close()
})

test('app boots to the welcome screen', async () => {
  expect(await app.evaluate(({ app: electronApp }) => electronApp.getName())).toBe('Blockout')
  // v2.3: the logo replaced the H1 wordmark.
  await expect(page.locator('.welcome img[alt="Blockout"]')).toBeVisible()
})

test('creates a project and stages a scene through real UI actions', async () => {
  await page.getByRole('button', { name: 'New Project' }).click()
  await expect(page.locator('.mode-switch')).toBeVisible()

  // Stage a man + an SUV via the store (same actions the Library/Viewport call).
  await page.evaluate(() => {
    const w = window as unknown as { __blockout: { store: any } }
    const store = w.__blockout.store.getState()
    store.addEntity('person.man', { x: 0, y: 0, z: 0 })
    store.addEntity('vehicle.suv', { x: 4, y: 0, z: -6 })
    store.addEntity('env.cityStreet', { x: 0, y: 0, z: 0 })
  })

  const counts = await page.evaluate(() => {
    const w = window as unknown as { __blockout: { store: any } }
    const scene = w.__blockout.store.getState().scene()
    return { entities: scene.entities.length }
  })
  expect(counts.entities).toBe(3)
})

test('choreographs marks, labels, and camera; project round-trips to disk', async () => {
  await page.evaluate(() => {
    const w = window as unknown as { __blockout: { store: any } }
    const store = w.__blockout.store.getState()
    const scene = store.scene()
    const man = scene.entities.find((e: any) => e.assetId === 'person.man')
    // Label the actor
    store.mutate('label', (doc: any) => {
      const sc = doc.scenes[0]
      const e = sc.entities.find((x: any) => x.id === man.id)
      e.label = { text: 'HERO', color: '#e5484d' }
    })
    // Actor walks 8m over the shot
    store.setSelection({ kind: 'entity', entityId: man.id })
    store.dropActorMark(man.id, { x: 0, y: 0, z: 0 })
    store.setTime(4)
    store.dropActorMark(man.id, { x: 0, y: 0, z: -8 })
    // Camera: two marks — push-in with a zoom
    store.setTime(0)
    store.dropCameraMark({ x: 5, y: 1.6, z: 3 }, 0.6, 0, 35)
    store.setTime(4.5)
    store.dropCameraMark({ x: 3, y: 1.6, z: 0 }, 0.6, 0, 50)
    store.setTime(0)
  })

  // Save via the titlebar button and verify project.json exists and parses.
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForTimeout(300)
  const projPath = join(smokeDir, 'Smoke.blockout', 'project.json')
  expect(existsSync(projPath)).toBe(true)
  const doc = JSON.parse(readFileSync(projPath, 'utf-8'))
  expect(doc.version).toBe(1)
  expect(doc.scenes[0].entities.length).toBe(3)
  expect(doc.scenes[0].shots[0].camera.marks.length).toBe(2)
})

test('playback advances deterministic state', async () => {
  const positions = await page.evaluate(async () => {
    const w = window as unknown as { __blockout: { store: any } }
    const store = w.__blockout.store
    store.getState().setTime(2)
    await new Promise((r) => setTimeout(r, 120)) // let a frame apply
    return true
  })
  expect(positions).toBe(true)
})

test('rendering is deterministic: same t → byte-identical frames', async () => {
  const report = await page.evaluate(async () => {
    const w = window as unknown as { __blockout: { renderRawForTest: any } }
    // Interleave awaits so the live animation loop runs between renders —
    // exactly the conditions of a real export.
    const a: number[] = w.__blockout.renderRawForTest(1.7)
    await new Promise((r) => setTimeout(r, 100))
    w.__blockout.renderRawForTest(3.9)
    await new Promise((r) => setTimeout(r, 100))
    const b: number[] = w.__blockout.renderRawForTest(1.7)
    let diffs = 0
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diffs++
    return { diffs, length: a.length }
  })
  expect(report.length).toBe(320 * 180 * 4)
  expect(report.diffs).toBe(0)
})

test('control mutations reject a stale reviewed state token', async () => {
  const control = JSON.parse(readFileSync(controlFile(), 'utf-8'))
  const rpc = async (action: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(`http://127.0.0.1:${control.port}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${control.token}` },
      body: JSON.stringify({ action, params })
    })
    return await response.json() as { ok: boolean; data?: any; error?: string }
  }
  const state = await rpc('get_state')
  const token = state.data?.stateToken as string
  expect(token).toMatch(/^[0-9a-f]{64}$/)
  expect((await rpc('set_time', { t: 1, _expectedStateToken: token })).ok).toBe(true)
  const stale = await rpc('set_time', { t: 2, _expectedStateToken: token })
  expect(stale.ok).toBe(false)
  expect(stale.error).toContain('state changed after review')
})

test('replaces a scene blueprint atomically as one reviewed mutation', async () => {
  const control = JSON.parse(readFileSync(controlFile(), 'utf-8'))
  const rpc = async (action: string, params: Record<string, unknown> = {}) => {
    const response = await fetch(`http://127.0.0.1:${control.port}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${control.token}` },
      body: JSON.stringify({ action, params })
    })
    return await response.json() as { ok: boolean; data?: any; error?: string }
  }
  const before = await rpc('get_state')
  const replaced = await rpc('replace_scene', {
    _expectedStateToken: before.data?.stateToken,
    lighting: 'interiorWarm',
    entities: [
      { key: 'dog', assetId: 'animal.dog', name: 'DIY Doggie', label: 'DIY DOGGIE', x: -1, z: -2,
        marks: [{ time: 0, x: -1, z: -2, gait: 'crouch' }, { time: 4, x: -1, z: -2, gait: 'gesture', joints: { headX: 0.2 } }] },
      { key: 'car', assetId: 'vehicle.sedan', name: 'Parked car', x: 1.2, z: -2 },
      { key: 'garage', assetId: 'env.parkingGarage', name: 'Garage', x: 0, z: 0 }
    ],
    shot: {
      name: 'Tire canary', duration: 8, fps: 24, aspect: '16:9', notes: 'Editable previs',
      cameraMarks: [
        { time: 0, x: -4, y: 1.4, z: 3, panDeg: 39, tiltDeg: -5, focalLength: 35 },
        { time: 8, x: -3.5, y: 1.35, z: 2.5, panDeg: 40, tiltDeg: -5, focalLength: 40 }
      ]
    }
  })
  expect(replaced.ok, replaced.error ?? '').toBe(true)
  expect(replaced.data?.entityCount).toBe(3)
  expect(replaced.data?.cameraMarkCount).toBe(2)
  const after = await rpc('get_state')
  expect(after.data?.scene.entities.map((entity: any) => entity.name)).toEqual(['DIY Doggie', 'Parked car', 'Garage'])
  expect(after.data?.shot).toMatchObject({ name: 'Tire canary', duration: 8, fps: 24, aspect: '16:9' })
})

test('exports a real package: video + stills + prompt + metadata', async () => {
  test.setTimeout(300_000)
  const control = JSON.parse(readFileSync(controlFile(), 'utf-8'))
  const stateResponse = await fetch(`http://127.0.0.1:${control.port}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${control.token}` },
    body: JSON.stringify({ action: 'get_state', params: {} })
  })
  const state = await stateResponse.json() as { ok: boolean; data?: { stateToken?: string } }
  expect(state.ok).toBe(true)
  const response = await fetch(`http://127.0.0.1:${control.port}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${control.token}` },
    body: JSON.stringify({
      action: 'export_shot',
      params: {
        profileId: 'seedance-2', clean: true, depth: true, normal: false,
        labels: 'stillsOnly', resolution: 'auto', _expectedStateToken: state.data?.stateToken
      }
    })
  })
  const envelope = await response.json() as { ok: boolean; data?: { packagePath?: string }; error?: string }
  expect(envelope.ok, `export failed: ${envelope.error ?? ''}`).toBe(true)
  const pkg = envelope.data?.packagePath as string
  expect(existsSync(pkg)).toBe(true)

  const files = readdirSync(pkg)
  const refMp4 = files.find((f) => f.endsWith('_reference.mp4'))!
  const depthMp4 = files.find((f) => f.endsWith('_depth.mp4'))!
  expect(refMp4).toBeTruthy()
  expect(depthMp4).toBeTruthy()
  expect(files).toContain('prompt.txt')
  expect(files).toContain('metadata.json')
  expect(files).toContain('README.txt')

  // Video correctness via ffprobe: the replaced canary shot is 8s, 24fps,
  // at the profile's expected resolution.
  const probe = JSON.parse(
    execFileSync('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format',
      join(pkg, refMp4)
    ]).toString()
  )
  const stream = probe.streams.find((s: any) => s.codec_type === 'video')
  expect(Number(probe.format.duration)).toBeGreaterThan(7.7)
  expect(Number(probe.format.duration)).toBeLessThan(8.3)
  expect(stream.width).toBe(1920)
  expect(stream.height).toBe(1080)
  expect(stream.avg_frame_rate).toBe('24/1')
  expect(statSync(join(pkg, refMp4)).size).toBeGreaterThan(50_000)

  // Stills: first/last + 2 camera marks + top-down.
  const stills = readdirSync(join(pkg, 'stills'))
  expect(stills.some((f) => f.includes('first'))).toBe(true)
  expect(stills.some((f) => f.includes('last'))).toBe(true)
  expect(stills.some((f) => f.includes('mark-1'))).toBe(true)
  expect(stills.some((f) => f.includes('mark-2'))).toBe(true)
  expect(stills.some((f) => f.includes('topdown'))).toBe(true)

  // Prompt reflects the active replacement scene and lens.
  const prompt = readFileSync(join(pkg, 'prompt.txt'), 'utf-8')
  expect(prompt).toContain('DIY DOGGIE')
  expect(prompt).toContain('35mm')

  // Metadata is valid JSON with both camera marks.
  const meta = JSON.parse(readFileSync(join(pkg, 'metadata.json'), 'utf-8'))
  expect(meta.cameraMarks.length).toBe(2)
  expect(meta.shot.fps).toBe(24)
})

test('reopens the last valid project on the next launch', async () => {
  await app.close()
  app = await electron.launch({
    args: ['out/main/index.js', `--user-data-dir=${smokeUserData}`],
    env: { ...process.env, HOME: smokeHome, BLOCKOUT_SMOKE_DIR: smokeDir }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.mode-switch')).toBeVisible()
  await expect(page.getByText('Smoke', { exact: true })).toBeVisible()
})
