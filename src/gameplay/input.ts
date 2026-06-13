// =============================================================================
// InputManager — キーボード入力管理
// window の keydown/keyup を購読し、InputState スナップショットを提供する。
// ショットキー・Space 離し・Esc はエッジ検出(poll() で1回だけ消費)。
// =============================================================================
import type { InputSource, InputState, ShotType } from '../types'

// ---------------------------------------------------------------------------
// キーマッピング
// ---------------------------------------------------------------------------

/** ショットキー(J/K/L/U/I) → ShotType への変換マップ */
const SHOT_KEY_MAP: Record<string, ShotType> = {
  KeyJ: 'flat',
  KeyK: 'topspin',
  KeyL: 'slice',
  KeyU: 'lob',
  KeyI: 'drop',
}

export class InputManager implements InputSource {
  // 現在のキー押下状態
  private held = new Set<string>()

  // 現在押下中のショットキー(押した順。先頭が「最初に押したもの」)。
  // shotHeld の判定とエッジ(shotPressed / shotReleased)の生成に使う。
  private heldShots: string[] = []

  // エッジ検出用: 次の poll() で一度だけ返す値
  private pendingShot: ShotType | null = null
  private pendingShotReleased: ShotType | null = null
  private pendingServeReleased = false
  private pendingEsc = false

  // keydown ハンドラ(型アノテーションのためにプロパティとして保持)
  private readonly onKeyDown: (e: KeyboardEvent) => void
  private readonly onKeyUp: (e: KeyboardEvent) => void

  constructor() {
    this.onKeyDown = (e: KeyboardEvent) => this.handleKeyDown(e)
    this.onKeyUp = (e: KeyboardEvent) => this.handleKeyUp(e)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
  }

  // ---------------------------------------------------------------------------
  // イベントハンドラ
  // ---------------------------------------------------------------------------

  private handleKeyDown(e: KeyboardEvent): void {
    // ブラウザのデフォルト動作(スクロール等)を抑制
    if (
      ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)
    ) {
      e.preventDefault()
    }

    if (this.held.has(e.code)) return // キーリピートは無視

    this.held.add(e.code)

    // ショットキーのエッジ検出(同フレーム複数押しは最初の1つのみ)
    const shot = SHOT_KEY_MAP[e.code]
    if (shot !== undefined) {
      // 押下中ショットキーの履歴に追加(押した順を保持)
      this.heldShots.push(e.code)
      if (this.pendingShot === null) {
        this.pendingShot = shot
      }
    }

    // Esc のエッジ検出
    if (e.code === 'Escape') {
      this.pendingEsc = true
    }
  }

  private handleKeyUp(e: KeyboardEvent): void {
    this.held.delete(e.code)

    // ショットキー離しのエッジ検出。離されたのが「現在の保持キー(先頭)」なら
    // shotReleased を立てる(同フレーム複数離しは最初の1つのみ)。
    const shot = SHOT_KEY_MAP[e.code]
    if (shot !== undefined) {
      const wasCurrent = this.heldShots[0] === e.code
      const idx = this.heldShots.indexOf(e.code)
      if (idx >= 0) this.heldShots.splice(idx, 1)
      if (wasCurrent && this.pendingShotReleased === null) {
        this.pendingShotReleased = shot
      }
    }

    // Space 離し(serveReleased)のエッジ検出
    if (e.code === 'Space') {
      this.pendingServeReleased = true
    }
  }

  // ---------------------------------------------------------------------------
  // InputSource 実装
  // ---------------------------------------------------------------------------

  /**
   * 物理フレームごとに呼び、現在の InputState スナップショットを返す。
   * エッジ検出値(shotPressed / serveReleased / escPressed)はここで消費される。
   */
  poll(): InputState {
    // 移動: WASD + 矢印キー
    const left = this.held.has('KeyA') || this.held.has('ArrowLeft')
    const right = this.held.has('KeyD') || this.held.has('ArrowRight')
    const up = this.held.has('KeyW') || this.held.has('ArrowUp')
    const down = this.held.has('KeyS') || this.held.has('ArrowDown')

    const moveX = (right ? 1 : 0) - (left ? 1 : 0)
    const moveZ = (down ? 1 : 0) - (up ? 1 : 0) // -1 = 前進(ネット方向 z-)

    const sprint = this.held.has('ShiftLeft') || this.held.has('ShiftRight')
    const spacePressed = this.held.has('Space')

    // serveReleased: Space が今フレーム離されたか
    // pendingServeReleased は keyup イベントで立てる
    const serveReleased = this.pendingServeReleased

    // shotHeld: 現在押しっぱなしのショットキー(最初に押したもの優先)。
    // 先頭キーを離すまで固定され、離したら次に古い押下キーへフォールバックする。
    const heldCode = this.heldShots[0]
    const shotHeld = heldCode !== undefined ? SHOT_KEY_MAP[heldCode] : null

    // エッジ値を消費
    const shotPressed = this.pendingShot
    const shotReleased = this.pendingShotReleased
    const escPressed = this.pendingEsc
    this.pendingShot = null
    this.pendingShotReleased = null
    this.pendingServeReleased = false
    this.pendingEsc = false

    return {
      moveX: moveX as -1 | 0 | 1,
      moveZ: moveZ as -1 | 0 | 1,
      sprint,
      shotPressed,
      shotHeld,
      shotReleased,
      servePressed: spacePressed,
      serveReleased,
      escPressed,
    }
  }

  // ---------------------------------------------------------------------------
  // 後処理
  // ---------------------------------------------------------------------------

  /** イベントリスナーを解除する */
  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    this.held.clear()
    this.heldShots = []
    this.pendingShot = null
    this.pendingShotReleased = null
    this.pendingServeReleased = false
    this.pendingEsc = false
  }
}
