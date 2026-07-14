import { access, chmod, mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname, isAbsolute, join } from 'path'

interface RecentProjectRecord {
  version: 1
  folder: string
}

export async function readRecentProject(recordPath: string): Promise<string | null> {
  try {
    const raw = await readFile(recordPath, 'utf-8')
    if (raw.length > 4096) throw new Error('recent-project record is too large')
    const record = JSON.parse(raw) as Partial<RecentProjectRecord>
    if (record.version !== 1 || typeof record.folder !== 'string') throw new Error('invalid record')
    if (!isAbsolute(record.folder) || !record.folder.endsWith('.blockout')) throw new Error('invalid folder')
    await access(join(record.folder, 'project.json'))
    return record.folder
  } catch {
    await rm(recordPath, { force: true }).catch(() => undefined)
    return null
  }
}

export async function writeRecentProject(recordPath: string, folder: string): Promise<void> {
  if (!isAbsolute(folder) || !folder.endsWith('.blockout')) throw new Error('invalid project folder')
  await access(join(folder, 'project.json'))
  await mkdir(dirname(recordPath), { recursive: true })
  const tempPath = `${recordPath}.${process.pid}.tmp`
  const record: RecentProjectRecord = { version: 1, folder }
  try {
    await writeFile(tempPath, `${JSON.stringify(record)}\n`, { encoding: 'utf-8', mode: 0o600 })
    await chmod(tempPath, 0o600)
    await rename(tempPath, recordPath)
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined)
  }
}

export async function clearRecentProject(recordPath: string): Promise<void> {
  await rm(recordPath, { force: true })
}
