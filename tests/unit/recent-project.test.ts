import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { readRecentProject, writeRecentProject } from '../../src/main/recent-project'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ folder: string; record: string }> {
  const root = await mkdtemp(join(tmpdir(), 'blockout-recent-'))
  roots.push(root)
  const folder = join(root, 'DIY Doggie.blockout')
  await mkdir(folder)
  await writeFile(join(folder, 'project.json'), '{}')
  return { folder, record: join(root, 'settings', 'last-project.json') }
}

describe('recent project persistence', () => {
  it('round-trips a valid Blockout project folder', async () => {
    const { folder, record } = await fixture()
    await writeRecentProject(record, folder)
    expect(await readRecentProject(record)).toBe(folder)
    expect(JSON.parse(await readFile(record, 'utf-8'))).toEqual({ version: 1, folder })
  })

  it('forgets stale records instead of blocking startup', async () => {
    const { folder, record } = await fixture()
    await writeRecentProject(record, folder)
    await rm(join(folder, 'project.json'))
    expect(await readRecentProject(record)).toBeNull()
    await expect(readFile(record, 'utf-8')).rejects.toThrow()
  })
})
