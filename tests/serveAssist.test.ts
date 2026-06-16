// =============================================================================
// 初心者向けサーブ補助の難易度ゲートの単体テスト(GAME_DESIGN §5.1)
// PlayerController に serveAssist=true/false を渡したとき、ServeMeterView の
// safePowerCap が SERVE_SAFE_POWER_MAX を出すか / null になるかを確認する。
// =============================================================================
import { describe, it, expect } from 'vitest'
import { PlayerController } from '../src/gameplay/player'
import { NEUTRAL_PERSONA_MODIFIERS, SERVE_SAFE_POWER_MAX } from '../src/constants'
import type { InputSource, InputState, PersonaPhysique } from '../src/types'

const idleInput: InputSource = {
  poll(): InputState {
    return {
      moveX: 0,
      moveZ: 0,
      sprint: false,
      shotPressed: null,
      shotHeld: null,
      shotReleased: null,
      servePressed: false,
      serveReleased: false,
      escPressed: false,
    }
  },
}

const physique: PersonaPhysique = { heightM: 1.85, build: 'athletic', handedness: 'right' }

describe('サーブ補助フラグの難易度ゲート', () => {
  it('serveAssist=true(easy/normal 相当)時はメーターに安全帯上限を出力する', () => {
    const ctrl = new PlayerController(idleInput, NEUTRAL_PERSONA_MODIFIERS, physique, true)
    // 初期サーブ種は flat
    expect(ctrl.serveMeter.serveType).toBe('flat')
    expect(ctrl.serveMeter.safePowerCap).toBe(SERVE_SAFE_POWER_MAX.flat)
  })

  it('serveAssist=false(hard 以上)時は safePowerCap=null で UI に出さない', () => {
    const ctrl = new PlayerController(idleInput, NEUTRAL_PERSONA_MODIFIERS, physique, false)
    expect(ctrl.serveMeter.safePowerCap).toBeNull()
  })

  it('デフォルト(引数省略)は補助 OFF', () => {
    const ctrl = new PlayerController(idleInput, NEUTRAL_PERSONA_MODIFIERS, physique)
    expect(ctrl.serveMeter.safePowerCap).toBeNull()
  })
})
