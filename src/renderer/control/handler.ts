/**
 * Renderer side of the agent control server (see src/main/control.ts and
 * mcp/blockout-mcp.mjs). External agents — Claude Code, Codex, Hermes, any
 * MCP client — drive the app through a whitelist of actions executed here
 * against the same store/scene paths the UI uses, so everything an agent
 * does is undoable, autosaved, and visible live.
 */

import { useStore } from '../store'
import { ASSET_CATALOG, assetSpec } from '@engine/assets'
import { createActorMark, createCameraMark, createEntity } from '@engine/schema'
import { newId } from '@engine/ids'
import { exportShot, renderStillPngForTest, type ExportResolution } from '../export/exporter'
import { getSceneManager } from '../export/scene-access'
import type { AspectId, GaitId } from '@engine/types'
import type { FramingKind } from '../bus'
import { BUILTIN_PROFILES } from '@engine/profiles'

type Params = Record<string, unknown>
type ControlResult = { ok: boolean; data?: unknown; error?: string }

const str = (p: Params, k: string): string | undefined =>
  typeof p[k] === 'string' ? (p[k] as string) : undefined
const flt = (p: Params, k: string): number | undefined =>
  typeof p[k] === 'number' && isFinite(p[k] as number) ? (p[k] as number) : undefined

const toRad = (deg: number): number => (deg * Math.PI) / 180
const toDeg = (rad: number): number => Math.round((rad * 180) / Math.PI)

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`
}

function serializedBoundState(): string {
  const s = useStore.getState()
  return canonical({
    doc: s.doc,
    projectFolder: s.projectFolder,
    sceneId: s.sceneId,
    shotId: s.shotId,
    time: s.time
  })
}

async function currentStateToken(): Promise<string> {
  // Web Crypto is async. Recheck the serialized state after hashing so the
  // returned token can never describe a snapshot that changed while awaiting.
  for (let attempt = 0; attempt < 4; attempt++) {
    const serialized = serializedBoundState()
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))
    if (serialized === serializedBoundState()) {
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
    }
  }
  throw new Error('Blockout is changing too quickly to bind a reviewed action — stop playback and retry.')
}

async function requireExpectedState(params: Params): Promise<string | undefined> {
  const expected = str(params, '_expectedStateToken')
  if (!expected) return undefined
  if (!/^[0-9a-f]{64}$/.test(expected) || expected !== (await currentStateToken())) {
    throw new Error('Blockout state changed after review — inspect and create a new plan.')
  }
  return expected
}

async function recheckExpectedState(expected: string | undefined): Promise<void> {
  if (expected && expected !== (await currentStateToken())) {
    throw new Error('Blockout state changed after review — inspect and create a new plan.')
  }
}

function requireManager(): NonNullable<ReturnType<typeof getSceneManager>> {
  const m = getSceneManager()
  if (!m) throw new Error('Viewport not ready yet — try again in a moment.')
  return m
}

function requireDoc(): void {
  if (!useStore.getState().doc) {
    throw new Error('No project open — create or open a project in the app first.')
  }
}

async function summary(): Promise<unknown> {
  const s = useStore.getState()
  const scene = s.scene()
  const shot = s.shot()
  const take = scene?.blocking.find((b) => b.id === shot?.blockingTakeId)
  return {
    project: s.doc?.name ?? null,
    projectFolder: s.projectFolder,
    mode: s.mode,
    time: s.time,
    scene: scene
      ? {
          id: scene.id,
          name: scene.name,
          lighting: scene.environment.lighting,
          entities: scene.entities.map((e) => ({
            id: e.id,
            name: e.name,
            assetId: e.assetId,
            x: e.transform.position.x,
            y: e.transform.position.y,
            z: e.transform.position.z,
            rotationDeg: toDeg(e.transform.rotationY),
            label: e.label?.text,
            attachedTo: e.attachedTo,
            markCount: take?.tracks.find((t) => t.entityId === e.id)?.marks.length ?? 0
          }))
        }
      : null,
    shot: shot
      ? {
          id: shot.id,
          name: shot.name,
          duration: shot.duration,
          fps: shot.fps,
          aspect: shot.aspect,
          camera: shot.cameraName ?? 'A',
          cameraMarks: shot.camera.marks.map((m, i) => ({
            index: i + 1,
            time: m.time,
            x: m.position.x,
            y: m.position.y,
            z: m.position.z,
            panDeg: toDeg(m.pan),
            tiltDeg: toDeg(m.tilt),
            focalLength: m.focalLength
          }))
        }
      : null,
    allShots: scene?.shots.map((sh) => ({ id: sh.id, name: sh.name })) ?? [],
    conventions:
      'meters; +X right, -Z forward; heading/pan 0 faces -Z; rotationDeg/panDeg clockwise from above',
    stateToken: await currentStateToken()
  }
}

async function execute(action: string, params: Params): Promise<unknown> {
  const expectedStateToken = action === 'get_state' ? undefined : await requireExpectedState(params)
  const s = useStore.getState()
  switch (action) {
    case 'get_state':
      return await summary()

    case 'list_assets': {
      const cat = str(params, 'category')
      return ASSET_CATALOG.filter((a) => !cat || a.category === cat).map((a) => ({
        id: a.id,
        name: a.name,
        category: a.category
      }))
    }

    case 'add_entity': {
      requireDoc()
      const assetId = str(params, 'assetId') ?? ''
      if (!ASSET_CATALOG.some((a) => a.id === assetId)) {
        throw new Error(`Unknown assetId "${assetId}" — call list_assets for valid ids.`)
      }
      const x = flt(params, 'x') ?? 0
      const z = flt(params, 'z') ?? 0
      const entityId = s.addEntity(assetId, { x, y: 0, z })
      const rotationDeg = flt(params, 'rotationDeg')
      const label = str(params, 'label')
      if (rotationDeg !== undefined || label) {
        s.mutate('agent: place entity', (doc) => {
          for (const scene of doc.scenes) {
            const e = scene.entities.find((en) => en.id === entityId)
            if (!e) continue
            if (rotationDeg !== undefined) e.transform.rotationY = toRad(rotationDeg)
            if (label) e.label = { text: label, color: e.label?.color ?? '#3b82f6' }
          }
        })
      }
      return { entityId, name: assetSpec(assetId)?.name }
    }

    case 'move_entity': {
      requireDoc()
      const entityId = str(params, 'entityId') ?? ''
      let found = false
      s.mutate('agent: move entity', (doc) => {
        for (const scene of doc.scenes) {
          const e = scene.entities.find((en) => en.id === entityId)
          if (!e) continue
          found = true
          const x = flt(params, 'x')
          const y = flt(params, 'y')
          const z = flt(params, 'z')
          const rotationDeg = flt(params, 'rotationDeg')
          if (x !== undefined) e.transform.position.x = x
          if (y !== undefined) e.transform.position.y = y
          if (z !== undefined) e.transform.position.z = z
          if (rotationDeg !== undefined) e.transform.rotationY = toRad(rotationDeg)
        }
      })
      if (!found) throw new Error(`No entity "${entityId}" — call get_state for ids.`)
      return { moved: entityId }
    }

    case 'delete_entity': {
      requireDoc()
      const entityId = str(params, 'entityId') ?? ''
      let found = false
      s.mutate('agent: delete entity', (doc) => {
        for (const scene of doc.scenes) {
          if (!scene.entities.some((e) => e.id === entityId)) continue
          found = true
          scene.entities = scene.entities.filter((e) => e.id !== entityId)
          for (const take of scene.blocking) {
            take.tracks = take.tracks.filter((t) => t.entityId !== entityId)
          }
          for (const sh of scene.shots) {
            if (sh.camera.mountEntityId === entityId) delete sh.camera.mountEntityId
          }
        }
      })
      if (!found) throw new Error(`No entity "${entityId}".`)
      if (useStore.getState().selection?.kind === 'entity') s.setSelection(null)
      return { deleted: entityId }
    }

    case 'replace_scene': {
      requireDoc()
      const rawEntities = params.entities
      const rawShot = params.shot
      if (!Array.isArray(rawEntities) || rawEntities.length < 1 || rawEntities.length > 32) {
        throw new Error('entities must contain 1–32 scene entities.')
      }
      if (!rawShot || typeof rawShot !== 'object' || Array.isArray(rawShot)) {
        throw new Error('shot must be an object.')
      }
      const entityKeys = new Set<string>()
      const entities = rawEntities.map((raw, index) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new Error(`entities[${index}] must be an object.`)
        }
        const value = raw as Params
        const key = str(value, 'key') ?? ''
        const assetId = str(value, 'assetId') ?? ''
        if (!/^[a-z][a-z0-9_-]{0,31}$/.test(key) || entityKeys.has(key)) {
          throw new Error(`entities[${index}].key must be unique and machine-safe.`)
        }
        if (!ASSET_CATALOG.some((asset) => asset.id === assetId)) {
          throw new Error(`entities[${index}] has unknown assetId "${assetId}".`)
        }
        entityKeys.add(key)
        const marksRaw = value.marks ?? []
        if (!Array.isArray(marksRaw) || marksRaw.length > 32) {
          throw new Error(`entities[${index}].marks must contain at most 32 marks.`)
        }
        const marks = marksRaw.map((rawMark, markIndex) => {
          if (!rawMark || typeof rawMark !== 'object' || Array.isArray(rawMark)) {
            throw new Error(`entities[${index}].marks[${markIndex}] must be an object.`)
          }
          const mark = rawMark as Params
          const gait = (str(mark, 'gait') ?? 'stand') as GaitId
          if (!['stand', 'walk', 'jog', 'run', 'sit', 'lie', 'crouch', 'gesture', 'fall'].includes(gait)) {
            throw new Error(`entities[${index}].marks[${markIndex}] has an invalid gait.`)
          }
          const jointsRaw = mark.joints
          let joints: Record<string, number> | undefined
          if (jointsRaw !== undefined) {
            if (!jointsRaw || typeof jointsRaw !== 'object' || Array.isArray(jointsRaw)) {
              throw new Error(`entities[${index}].marks[${markIndex}].joints must be an object.`)
            }
            const entries = Object.entries(jointsRaw)
            if (entries.length > 32 || entries.some(([name, amount]) =>
              !/^[a-zA-Z][a-zA-Z0-9]{0,31}$/.test(name)
              || typeof amount !== 'number' || !isFinite(amount) || Math.abs(amount) > Math.PI)) {
              throw new Error(`entities[${index}].marks[${markIndex}].joints is invalid.`)
            }
            joints = Object.fromEntries(entries) as Record<string, number>
          }
          return {
            time: flt(mark, 'time') ?? 0,
            x: flt(mark, 'x') ?? 0,
            y: flt(mark, 'y') ?? 0,
            z: flt(mark, 'z') ?? 0,
            gait,
            arriveHeadingDeg: flt(mark, 'arriveHeadingDeg'),
            joints
          }
        })
        return {
          key,
          assetId,
          name: str(value, 'name'),
          label: str(value, 'label'),
          x: flt(value, 'x') ?? 0,
          y: flt(value, 'y') ?? 0,
          z: flt(value, 'z') ?? 0,
          rotationDeg: flt(value, 'rotationDeg') ?? 0,
          marks
        }
      })
      const shotValue = rawShot as Params
      const duration = flt(shotValue, 'duration') ?? 8
      const fps = flt(shotValue, 'fps') ?? 24
      const aspect = (str(shotValue, 'aspect') ?? '16:9') as AspectId
      const cameraMarksRaw = shotValue.cameraMarks
      if (duration < 0.5 || duration > 600 || ![24, 25, 30].includes(fps)
          || !['16:9', '9:16', '2.39:1', '4:3', '1:1'].includes(aspect)
          || !Array.isArray(cameraMarksRaw) || cameraMarksRaw.length < 1 || cameraMarksRaw.length > 32) {
        throw new Error('shot duration, fps, aspect, or cameraMarks is invalid.')
      }
      const cameraMarks = cameraMarksRaw.map((rawMark, index) => {
        if (!rawMark || typeof rawMark !== 'object' || Array.isArray(rawMark)) {
          throw new Error(`shot.cameraMarks[${index}] must be an object.`)
        }
        const mark = rawMark as Params
        return {
          time: flt(mark, 'time') ?? 0,
          x: flt(mark, 'x') ?? 0,
          y: flt(mark, 'y') ?? 1.6,
          z: flt(mark, 'z') ?? 4,
          panDeg: flt(mark, 'panDeg') ?? 0,
          tiltDeg: flt(mark, 'tiltDeg') ?? 0,
          focalLength: flt(mark, 'focalLength') ?? 35
        }
      })
      if (entities.some((entity) => entity.marks.some((mark) => mark.time < 0 || mark.time > duration))
          || cameraMarks.some((mark) => mark.time < 0 || mark.time > duration)) {
        throw new Error('all entity and camera marks must fall within the shot duration.')
      }
      const lighting = str(params, 'lighting')
      if (lighting && !['day', 'goldenHour', 'night', 'interiorWarm', 'interiorCool', 'club'].includes(lighting)) {
        throw new Error('lighting is invalid.')
      }
      const scene = s.scene()
      const shot = s.shot()
      const take = scene?.blocking.find((candidate) => candidate.id === shot?.blockingTakeId)
      if (!scene || !shot || !take) throw new Error('No current scene, shot, or blocking take.')
      const created = entities.map((value) => {
        const entity = createEntity(value.assetId, value.name || assetSpec(value.assetId)!.name, {
          x: value.x, y: value.y, z: value.z
        })
        entity.transform.rotationY = toRad(value.rotationDeg)
        if (value.label) entity.label = { text: value.label, color: '#3b82f6' }
        return { value, entity }
      })
      s.mutate('agent: replace scene blueprint', (doc) => {
        const targetScene = doc.scenes.find((candidate) => candidate.id === scene.id)
        const targetShot = targetScene?.shots.find((candidate) => candidate.id === shot.id)
        const targetTake = targetScene?.blocking.find((candidate) => candidate.id === take.id)
        if (!targetScene || !targetShot || !targetTake) return
        targetScene.entities = created.map(({ entity }) => entity)
        for (const candidate of targetScene.blocking) candidate.tracks = []
        targetTake.tracks = created
          .filter(({ value }) => value.marks.length > 0)
          .map(({ value, entity }) => ({
            entityId: entity.id,
            marks: value.marks.map((valueMark) => {
              const mark = createActorMark(
                { x: valueMark.x, y: valueMark.y, z: valueMark.z },
                valueMark.time,
                valueMark.gait
              )
              if (valueMark.arriveHeadingDeg !== undefined) {
                mark.arriveHeading = toRad(valueMark.arriveHeadingDeg)
              }
              if (valueMark.joints) mark.joints = valueMark.joints
              return mark
            })
          }))
        targetShot.name = str(shotValue, 'name') || targetShot.name
        targetShot.duration = duration
        targetShot.fps = fps
        targetShot.aspect = aspect
        targetShot.notes = str(shotValue, 'notes')
        targetShot.camera.marks = cameraMarks.map((valueMark) => createCameraMark(
          { x: valueMark.x, y: valueMark.y, z: valueMark.z },
          valueMark.time,
          toRad(valueMark.panDeg),
          toRad(valueMark.tiltDeg),
          valueMark.focalLength
        ))
        delete targetShot.camera.mountEntityId
        delete targetShot.camera.trackEntityId
        if (lighting) targetScene.environment.lighting = lighting as typeof targetScene.environment.lighting
      })
      s.setSelection(null)
      s.setTime(0)
      return {
        replaced: true,
        entityIds: Object.fromEntries(created.map(({ value, entity }) => [value.key, entity.id])),
        entityCount: created.length,
        cameraMarkCount: cameraMarks.length,
        duration
      }
    }

    case 'add_actor_mark': {
      requireDoc()
      const entityId = str(params, 'entityId') ?? ''
      const time = flt(params, 'time') ?? 0
      const x = flt(params, 'x') ?? 0
      const z = flt(params, 'z') ?? 0
      const y = flt(params, 'y') ?? 0
      const gait = (str(params, 'gait') ?? 'walk') as GaitId
      let ok = false
      s.mutate('agent: actor mark', (doc) => {
        const scene = doc.scenes.find((sc) => sc.id === useStore.getState().sceneId)
        const shot = scene?.shots.find((sh) => sh.id === useStore.getState().shotId)
        const take = scene?.blocking.find((b) => b.id === shot?.blockingTakeId)
        if (!scene || !take || !scene.entities.some((e) => e.id === entityId)) return
        let track = take.tracks.find((t) => t.entityId === entityId)
        if (!track) {
          track = { entityId, marks: [] }
          take.tracks.push(track)
        }
        track.marks.push(createActorMark({ x, y, z }, time, gait))
        ok = true
      })
      if (!ok) throw new Error(`No entity "${entityId}" in the current scene.`)
      return { added: true }
    }

    case 'add_camera_mark': {
      requireDoc()
      const mark = createCameraMark(
        { x: flt(params, 'x') ?? 0, y: flt(params, 'y') ?? 1.6, z: flt(params, 'z') ?? 4 },
        flt(params, 'time') ?? 0,
        toRad(flt(params, 'panDeg') ?? 0),
        toRad(flt(params, 'tiltDeg') ?? 0),
        flt(params, 'focalLength') ?? 35
      )
      s.mutate('agent: camera mark', (doc) => {
        const scene = doc.scenes.find((sc) => sc.id === useStore.getState().sceneId)
        const shot = scene?.shots.find((sh) => sh.id === useStore.getState().shotId)
        shot?.camera.marks.push(mark)
      })
      return { added: true }
    }

    case 'clear_camera_marks':
      requireDoc()
      s.clearCameraMarks()
      return { cleared: true }

    case 'set_shot': {
      requireDoc()
      s.mutate('agent: set shot', (doc) => {
        const scene = doc.scenes.find((sc) => sc.id === useStore.getState().sceneId)
        const shot = scene?.shots.find((sh) => sh.id === useStore.getState().shotId)
        if (!shot) return
        const name = str(params, 'name')
        const duration = flt(params, 'duration')
        const fps = flt(params, 'fps')
        const aspect = str(params, 'aspect') as AspectId | undefined
        if (name) shot.name = name
        // Never clamp marks on duration change — blocking is shared.
        if (duration !== undefined) shot.duration = Math.min(600, Math.max(0.5, duration))
        if (fps === 24 || fps === 25 || fps === 30) shot.fps = fps
        if (aspect && ['16:9', '9:16', '2.39:1', '4:3', '1:1'].includes(aspect)) {
          shot.aspect = aspect
        }
      })
      return { ok: true }
    }

    case 'new_shot': {
      requireDoc()
      const sceneId = useStore.getState().sceneId
      if (!sceneId) throw new Error('No scene selected.')
      s.addShotToScene(sceneId)
      const st = useStore.getState()
      const name = str(params, 'name')
      if (name) {
        st.mutate('agent: name shot', (doc) => {
          const scene = doc.scenes.find((sc) => sc.id === sceneId)
          const shot = scene?.shots.find((sh) => sh.id === st.shotId)
          if (shot) shot.name = name
        })
      }
      return { shotId: useStore.getState().shotId }
    }

    case 'apply_framing': {
      requireDoc()
      const kind = str(params, 'kind') as FramingKind | undefined
      if (!kind || !['2S', 'OTS', 'REV', 'TOP', 'LOW', 'DUTCH'].includes(kind)) {
        throw new Error('kind must be one of 2S, OTS, REV, TOP, LOW, DUTCH.')
      }
      requireManager().applyFraming(kind)
      return { applied: kind }
    }

    case 'apply_camera_move': {
      requireDoc()
      const presetId = str(params, 'presetId') ?? ''
      const subjectId = str(params, 'entityId')
      const { CAMERA_MOVE_PRESETS } = await import('@engine/camera-moves')
      await recheckExpectedState(expectedStateToken)
      if (subjectId) {
        if (!s.scene()?.entities.some((e) => e.id === subjectId)) {
          throw new Error(`No entity "${subjectId}".`)
        }
        s.setSelection({ kind: 'entity', entityId: subjectId })
      }
      if (!CAMERA_MOVE_PRESETS.some((p) => p.id === presetId)) {
        throw new Error(
          `Unknown presetId "${presetId}". Valid: ${CAMERA_MOVE_PRESETS.map((p) => p.id).join(', ')}`
        )
      }
      requireManager().applyCameraMove(presetId)
      return { applied: presetId }
    }

    case 'list_camera_moves': {
      const { CAMERA_MOVE_PRESETS } = await import('@engine/camera-moves')
      return CAMERA_MOVE_PRESETS.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        description: p.description,
        track: p.track
      }))
    }

    case 'set_track_subject': {
      requireDoc()
      const entityId = str(params, 'entityId') // empty/undefined = off
      if (entityId && !s.scene()?.entities.some((e) => e.id === entityId)) {
        throw new Error(`No entity "${entityId}".`)
      }
      s.mutate('agent: track subject', (doc) => {
        const scene = doc.scenes.find((sc) => sc.id === useStore.getState().sceneId)
        const shot = scene?.shots.find((sh) => sh.id === useStore.getState().shotId)
        if (!shot) return
        if (entityId) shot.camera.trackEntityId = entityId
        else delete shot.camera.trackEntityId
      })
      return { tracking: entityId ?? null }
    }

    case 'list_action_presets': {
      const { ACTION_PRESETS } = await import('@engine/action-presets')
      return ACTION_PRESETS.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        description: p.description,
        suggestedAssets: p.suggestedAssets
      }))
    }

    case 'apply_action_preset': {
      requireDoc()
      const entityId = str(params, 'entityId') ?? ''
      const presetId = str(params, 'presetId') ?? ''
      const { ACTION_PRESETS } = await import('@engine/action-presets')
      await recheckExpectedState(expectedStateToken)
      const preset = ACTION_PRESETS.find((p) => p.id === presetId)
      if (!preset) {
        throw new Error(
          `Unknown presetId "${presetId}". Valid: ${ACTION_PRESETS.map((p) => p.id).join(', ')}`
        )
      }
      const scene = s.scene()
      const shot = s.shot()
      const entity = scene?.entities.find((e) => e.id === entityId)
      if (!scene || !shot || !entity) throw new Error(`No entity "${entityId}".`)
      const specs = preset.generate({
        start: {
          x: entity.transform.position.x,
          y: entity.transform.position.y,
          z: entity.transform.position.z,
          heading: entity.transform.rotationY
        },
        duration: shot.duration
      })
      s.mutate('agent: action preset', (doc) => {
        const sc = doc.scenes.find((x) => x.id === scene.id)
        const sh = sc?.shots.find((x) => x.id === shot.id)
        const take = sc?.blocking.find((b) => b.id === sh?.blockingTakeId)
        if (!take) return
        let track = take.tracks.find((t) => t.entityId === entityId)
        if (!track) {
          track = { entityId, marks: [] }
          take.tracks.push(track)
        }
        track.marks = specs.map((spec) => ({
          id: newId('mark'),
          time: spec.time,
          hold: spec.hold,
          easeIn: spec.easeIn,
          easeOut: spec.easeOut,
          position: { ...spec.position },
          gait: spec.gait
        }))
      })
      return { applied: presetId, marks: specs.length }
    }

    case 'list_sequence_styles': {
      const { sequenceStyles } = await import('@engine/sequences')
      return {
        dance: sequenceStyles('dance'),
        fight: sequenceStyles('fight'),
        footChase: sequenceStyles('footChase'),
        carChase: sequenceStyles('carChase')
      }
    }

    case 'spawn_sequence': {
      requireDoc()
      const type = str(params, 'type') as
        | import('@engine/sequences').SequenceType
        | undefined
      if (!type || !['dance', 'fight', 'footChase', 'carChase'].includes(type)) {
        throw new Error('type must be dance | fight | footChase | carChase.')
      }
      const count = flt(params, 'count') ?? 10
      const style = str(params, 'style') ?? (type === 'dance' ? 'mixed' : type === 'fight' ? 'paired' : 'straight')
      const x = flt(params, 'x') ?? 0
      const z = flt(params, 'z') ?? 0
      const headingDeg = flt(params, 'headingDeg') ?? 0
      s.spawnSequence({ type, count, style, origin: { x, z, heading: toRad(headingDeg) } })
      const after = useStore.getState()
      const sel = after.selection
      return {
        staged: sel?.kind === 'entities' ? sel.entityIds.length : 0,
        entityIds: sel?.kind === 'entities' ? sel.entityIds : []
      }
    }

    case 'snap_to_ground': {
      requireDoc()
      const entityId = str(params, 'entityId') ?? ''
      const scene = s.scene()
      if (!scene?.entities.some((e) => e.id === entityId)) {
        throw new Error(`No entity "${entityId}".`)
      }
      s.setSelection({ kind: 'entity', entityId })
      requireManager().snapSelectionToGround()
      return { snapped: entityId }
    }

    case 'set_time':
      requireDoc()
      s.setTime(Math.max(0, flt(params, 't') ?? 0))
      return { time: useStore.getState().time }

    case 'play':
      requireDoc()
      s.setTime(0)
      s.setPlaying(true)
      return { playing: true }

    case 'stop':
      s.setPlaying(false)
      return { playing: false }

    case 'screenshot': {
      requireDoc()
      // Rendered through the SHOT camera at the playhead — what will export.
      const png = await renderStillPngForTest(useStore.getState().time, 960, 540)
      let binary = ''
      const bytes = new Uint8Array(png)
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
      return { imageBase64: btoa(binary) }
    }

    case 'export_shot': {
      requireDoc()
      const profileId = str(params, 'profileId') ?? ''
      if (!BUILTIN_PROFILES.some((profile) => profile.id === profileId)) {
        throw new Error(`Unknown profileId "${profileId}".`)
      }
      const labels = str(params, 'labels') ?? 'stillsOnly'
      if (!['on', 'stillsOnly', 'off'].includes(labels)) {
        throw new Error('labels must be on, stillsOnly, or off.')
      }
      const resolution = str(params, 'resolution') ?? 'auto'
      if (!['auto', '720p', '1080p'].includes(resolution)) {
        throw new Error('resolution must be auto, 720p, or 1080p.')
      }
      const result = await exportShot({
        profileId,
        passes: {
          clean: params.clean !== false,
          depth: params.depth !== false,
          normal: params.normal === true
        },
        labels: labels as 'on' | 'stillsOnly' | 'off',
        resolution: resolution as ExportResolution
      })
      if (!result.ok || !result.packagePath) {
        throw new Error(result.error ?? 'Blockout export did not return a package path.')
      }
      if (expectedStateToken && expectedStateToken !== (await currentStateToken())) {
        throw new Error('Blockout changed during export; discard the package and create a new plan.')
      }
      return { packagePath: result.packagePath }
    }

    case 'set_reference': {
      requireDoc()
      const videoPath = str(params, 'videoPath') ?? str(params, 'path') ?? ''
      if (!videoPath) throw new Error('videoPath is required.')
      const folder = useStore.getState().projectFolder
      if (!folder) throw new Error('No project folder — save the project first.')
      const mode = str(params, 'mode') === 'pip' ? 'pip' : 'ghost'
      const rawOpacity = flt(params, 'opacity')
      const opacity = rawOpacity === undefined ? 0.5 : Math.min(1, Math.max(0, rawOpacity))
      // Copy the external clip into the project's refs/ folder so it travels
      // with the project and can be served by relative path.
      const imported = await window.blockout.importReference(folder, videoPath)
      if (expectedStateToken && expectedStateToken !== (await currentStateToken())) {
        throw new Error('Blockout changed while importing the reference; inspect and create a new plan.')
      }
      let attached = false
      s.mutate('agent: set reference', (doc) => {
        const scene = doc.scenes.find((sc) => sc.id === useStore.getState().sceneId)
        const shot = scene?.shots.find((sh) => sh.id === useStore.getState().shotId)
        if (!shot) return
        shot.referenceVideo = { path: imported.relativePath, opacity, mode, timeOffset: 0 }
        attached = true
      })
      if (!attached) throw new Error('No active shot to attach the reference to.')
      return { attached: true, path: imported.relativePath, mode, opacity }
    }

    case 'list_presets':
      return await window.blockout.presetsList()

    case 'save_preset': {
      requireDoc()
      const name = str(params, 'name')
      if (!name) throw new Error('name is required.')
      await s.saveStagePreset(name)
      return { saved: name }
    }

    case 'apply_preset': {
      requireDoc()
      const id = str(params, 'id')
      if (!id) throw new Error('id is required — call list_presets.')
      await s.applyStagePreset(id)
      return { applied: id }
    }

    default:
      throw new Error(`Unknown action "${action}".`)
  }
}

/** Wire up control-invoke handling. Returns an unsubscribe for teardown. */
export function registerControlHandler(): () => void {
  return window.blockout.onControlInvoke((id, action, params) => {
    void (async () => {
      let result: ControlResult
      try {
        const data = await execute(action, (params ?? {}) as Params)
        result = { ok: true, data }
      } catch (e) {
        result = { ok: false, error: (e as Error).message }
      }
      window.blockout.controlResult(id, result)
    })()
  })
}
