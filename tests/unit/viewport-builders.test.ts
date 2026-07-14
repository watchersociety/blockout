import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { buildAsset } from '../../src/renderer/viewport/builders'

describe('viewport blocking truthfulness', () => {
  it('shows quadruped crouch and head overrides in the rendered rig', () => {
    const dog = buildAsset('animal.dog')
    const body = dog.group.getObjectByName('quadruped-body')
    const head = dog.group.getObjectByName('quadruped-head-pivot')
    expect(body).toBeDefined()
    expect(head).toBeDefined()
    const standingY = body!.position.y

    dog.animate?.({
      gait: 'crouch', phase: 0, speed: 0, distance: 0, time: 1,
      overrides: { headX: 0.24, headY: -0.1 }
    })

    expect(body!.position.y).toBeLessThan(standingY)
    expect(head!.rotation.x).toBeCloseTo(0.24)
    expect(head!.rotation.y).toBeCloseTo(-0.1)
  })

  it('keeps the parking-garage ceiling visible inside but culled above the editor stage', () => {
    const garage = buildAsset('env.parkingGarage')
    const ceiling = garage.group.getObjectByName('editor-cull-ceiling') as THREE.Mesh
    expect(ceiling).toBeDefined()
    expect(ceiling.geometry).toBeInstanceOf(THREE.PlaneGeometry)
    expect((ceiling.material as THREE.Material).side).toBe(THREE.FrontSide)
    expect(ceiling.rotation.x).toBeCloseTo(Math.PI / 2)
  })
})
