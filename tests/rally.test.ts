// =============================================================================
// ラリー判定の単体テスト
// 仕様: docs/ARCHITECTURE.md §8、§16
// BallState は Vector3 を使ってモックする
// =============================================================================
import { describe, it, expect, beforeEach } from 'vitest'
import { Vector3 } from 'three'
import { RallyJudge } from '../src/core/rally'
import type { BallState, BallEvent, ServiceBox } from '../src/types'
import {
  COURT_HALF_LENGTH,
  COURT_HALF_WIDTH,
  SERVICE_LINE_Z,
  BALL_RADIUS,
} from '../src/constants'

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

/** BallState のモックを生成する */
function makeBall(
  overrides: Partial<BallState> & { x?: number; y?: number; z?: number },
): BallState {
  const { x = 0, y = 0, z = 0, ...rest } = overrides
  return {
    pos: new Vector3(x, y, z),
    vel: new Vector3(0, 0, 0),
    spin: new Vector3(0, 0, 0),
    bounceCount: 0,
    lastHitBy: null,
    inPlay: true,
    ...rest,
  }
}

/** bounce イベントを生成する */
function bounceEvent(x: number, z: number): BallEvent {
  return { kind: 'bounce', pos: new Vector3(x, 0, z) }
}

/** hit イベントを生成する */
function hitEvent(by: 'player' | 'opponent'): BallEvent {
  return { kind: 'hit', by, shot: 'flat' }
}

/** net イベント */
const netEvent: BallEvent = { kind: 'net' }

/**
 * 標準サービスボックスを生成する。
 * player がサーブする場合: 受け手は opponent(z<0)
 *   - zSign = -1
 *   - ワイド(右から打つ → opponent の左側 = x負)かデュースサイド等
 * ここでは x: [0, COURT_HALF_WIDTH] のボックス(デュースサイド右半)を使う
 */
function makeServiceBox(zSign: 1 | -1, xMin: number, xMax: number): ServiceBox {
  return { zSign, xMin, xMax }
}

// player がサーブする時の標準的なサービスボックス(opponent コート: z<0, x右半)
const PLAYER_SERVE_BOX: ServiceBox = makeServiceBox(-1, 0, COURT_HALF_WIDTH)
// opponent がサーブする時のサービスボックス(player コート: z>0, x右半)
const OPPONENT_SERVE_BOX: ServiceBox = makeServiceBox(1, 0, COURT_HALF_WIDTH)

// ---------------------------------------------------------------------------
// RallyJudge のセットアップ
// ---------------------------------------------------------------------------

let judge: RallyJudge

beforeEach(() => {
  judge = new RallyJudge()
  judge.reset('player', PLAYER_SERVE_BOX)
})

// ---------------------------------------------------------------------------
// サーブフォルト判定
// ---------------------------------------------------------------------------

describe('RallyJudge — サーブフォルト', () => {
  it('サービスボックス内に着地したらラリー継続(null)', () => {
    // opponent コート(z<0)のサービスボックス内
    const ball = makeBall({ bounceCount: 1 })
    const z = -(SERVICE_LINE_Z / 2) // サービスライン手前
    const x = COURT_HALF_WIDTH / 2  // センター〜サイド間
    const verdict = judge.onEvent(bounceEvent(x, z), ball)
    expect(verdict).toBeNull()
  })

  it('サービスライン後方にバウンドしたらfault', () => {
    const ball = makeBall({ bounceCount: 1 })
    const z = -(SERVICE_LINE_Z + 1.0) // サービスライン後方
    const verdict = judge.onEvent(bounceEvent(0, z), ball)
    expect(verdict).not.toBeNull()
    expect(verdict?.reason).toBe('fault')
    expect(verdict?.winner).toBe('opponent') // 受け手が winner
  })

  it('センターラインを超えた外側にバウンドしたらfault', () => {
    const ball = makeBall({ bounceCount: 1 })
    // x が COURT_HALF_WIDTH を超える → サービスボックス外
    const x = COURT_HALF_WIDTH + 0.5
    const z = -(SERVICE_LINE_Z / 2)
    const verdict = judge.onEvent(bounceEvent(x, z), ball)
    expect(verdict).not.toBeNull()
    expect(verdict?.reason).toBe('fault')
  })

  it('サーバー自陣コートにバウンドしたらfault', () => {
    const ball = makeBall({ bounceCount: 1 })
    // player がサーブ、自陣(z>0)にバウンド
    const verdict = judge.onEvent(bounceEvent(0, 3.0), ball)
    expect(verdict).not.toBeNull()
    expect(verdict?.reason).toBe('fault')
  })

  it('サービスボックスの端ぎりぎり(ライン上)はイン', () => {
    const ball = makeBall({ bounceCount: 1 })
    // x = COURT_HALF_WIDTH(サイドライン外縁)
    // BALL_RADIUS 以内ならイン
    const x = COURT_HALF_WIDTH - BALL_RADIUS / 2
    const z = -(SERVICE_LINE_Z - BALL_RADIUS / 2)
    const verdict = judge.onEvent(bounceEvent(x, z), ball)
    expect(verdict).toBeNull() // イン → ラリー継続
  })

  it('opponent がサーブしてサービスボックス内に入ったらラリー継続', () => {
    judge.reset('opponent', OPPONENT_SERVE_BOX)
    const ball = makeBall({ bounceCount: 1 })
    const z = SERVICE_LINE_Z / 2  // player コート(z>0)のサービスボックス内
    const x = COURT_HALF_WIDTH / 2
    const verdict = judge.onEvent(bounceEvent(x, z), ball)
    expect(verdict).toBeNull()
  })

  it('opponent がサーブしてサービスライン後方ならfault', () => {
    judge.reset('opponent', OPPONENT_SERVE_BOX)
    const ball = makeBall({ bounceCount: 1 })
    const z = SERVICE_LINE_Z + 1.0 // player コートのサービスライン後方
    const verdict = judge.onEvent(bounceEvent(0, z), ball)
    expect(verdict?.reason).toBe('fault')
    expect(verdict?.winner).toBe('player') // 受け手(player)が winner
  })
})

// ---------------------------------------------------------------------------
// ラリー中のバウンド判定
// ---------------------------------------------------------------------------

describe('RallyJudge — 通常ラリー(イン/アウト)', () => {
  /**
   * サーブを成功させてラリーに移行するヘルパー。
   * player がサーブ → opponent コートのサービスボックスに着地。
   */
  function enterRallyFromPlayerServe(): void {
    judge.reset('player', PLAYER_SERVE_BOX)
    // サーブが成功 → ラリーフェーズへ
    const serveBall = makeBall({ bounceCount: 1 })
    const inBox = judge.onEvent(bounceEvent(COURT_HALF_WIDTH / 2, -(SERVICE_LINE_Z / 2)), serveBall)
    // インなのでnullのはず(ラリー継続)
    expect(inBox).toBeNull()
  }

  it('打球が opponent コート内にバウンド → ラリー継続(null)', () => {
    enterRallyFromPlayerServe()
    // player が打って opponent コート(z<0)中央に着地
    judge.onEvent(hitEvent('player'), makeBall({}))
    const ball = makeBall({ bounceCount: 1 })
    const verdict = judge.onEvent(bounceEvent(0, -5.0), ball)
    expect(verdict).toBeNull()
  })

  it('打球が opponent コートのアウト → player 失点(out)', () => {
    enterRallyFromPlayerServe()
    judge.onEvent(hitEvent('player'), makeBall({}))
    // x がサイドライン外(コート外)
    const x = COURT_HALF_WIDTH + 1.0
    const ball = makeBall({ bounceCount: 1 })
    const verdict = judge.onEvent(bounceEvent(x, -5.0), ball)
    expect(verdict).not.toBeNull()
    expect(verdict?.reason).toBe('out')
    expect(verdict?.winner).toBe('opponent') // 打った side の失点 → 相手が winner
  })

  it('打球がベースライン後方にアウト → 打った側の失点', () => {
    enterRallyFromPlayerServe()
    judge.onEvent(hitEvent('player'), makeBall({}))
    const z = -(COURT_HALF_LENGTH + 1.0) // ベースライン後方
    const ball = makeBall({ bounceCount: 1 })
    const verdict = judge.onEvent(bounceEvent(0, z), ball)
    expect(verdict?.reason).toBe('out')
    expect(verdict?.winner).toBe('opponent')
  })

  it('ライン上(サイドライン外縁 + BALL_RADIUS 以内)はイン', () => {
    enterRallyFromPlayerServe()
    judge.onEvent(hitEvent('player'), makeBall({}))
    // x = COURT_HALF_WIDTH + BALL_RADIUS / 2 → イン
    const x = COURT_HALF_WIDTH + BALL_RADIUS / 2
    const ball = makeBall({ bounceCount: 1 })
    const verdict = judge.onEvent(bounceEvent(x, -5.0), ball)
    expect(verdict).toBeNull()
  })

  it('ライン外縁 + BALL_RADIUS を超えたらアウト', () => {
    enterRallyFromPlayerServe()
    judge.onEvent(hitEvent('player'), makeBall({}))
    // x = COURT_HALF_WIDTH + BALL_RADIUS + 0.001 → アウト
    const x = COURT_HALF_WIDTH + BALL_RADIUS + 0.001
    const ball = makeBall({ bounceCount: 1 })
    const verdict = judge.onEvent(bounceEvent(x, -5.0), ball)
    expect(verdict?.reason).toBe('out')
  })
})

// ---------------------------------------------------------------------------
// 自陣バウンド(ネットを越えなかった)
// ---------------------------------------------------------------------------

describe('RallyJudge — 自陣バウンド', () => {
  it('player が打って自陣(z>0)でバウンド → player 失点', () => {
    // ラリーフェーズに入るためサーブをシミュレート
    judge.reset('player', PLAYER_SERVE_BOX)
    const serveBall = makeBall({ bounceCount: 1 })
    judge.onEvent(bounceEvent(COURT_HALF_WIDTH / 2, -(SERVICE_LINE_Z / 2)), serveBall)

    // player がラリーショット
    judge.onEvent(hitEvent('player'), makeBall({}))
    // player 自陣(z>0)でバウンド → player 失点
    const ball = makeBall({ bounceCount: 1 })
    const verdict = judge.onEvent(bounceEvent(0, 3.0), ball)
    expect(verdict).not.toBeNull()
    expect(verdict?.winner).toBe('opponent')
    expect(verdict?.reason).toBe('net') // ネットを越えずに自陣バウンド
  })

  it('opponent が打って自陣(z<0)でバウンド → opponent 失点', () => {
    judge.reset('player', PLAYER_SERVE_BOX)
    const serveBall = makeBall({ bounceCount: 1 })
    judge.onEvent(bounceEvent(COURT_HALF_WIDTH / 2, -(SERVICE_LINE_Z / 2)), serveBall)

    // opponent がラリーショット
    judge.onEvent(hitEvent('opponent'), makeBall({}))
    // opponent 自陣(z<0)でバウンド → opponent 失点
    const ball = makeBall({ bounceCount: 1 })
    const verdict = judge.onEvent(bounceEvent(0, -3.0), ball)
    expect(verdict).not.toBeNull()
    expect(verdict?.winner).toBe('player')
    expect(verdict?.reason).toBe('net')
  })
})

// ---------------------------------------------------------------------------
// 2バウンド(doubleBounce)
// ---------------------------------------------------------------------------

describe('RallyJudge — doubleBounce', () => {
  it('opponent コートで2バウンド → opponent 失点(doubleBounce)', () => {
    judge.reset('player', PLAYER_SERVE_BOX)
    // サーブ成功
    judge.onEvent(bounceEvent(COURT_HALF_WIDTH / 2, -(SERVICE_LINE_Z / 2)), makeBall({ bounceCount: 1 }))

    // player がラリーショット → opponent コートにバウンド → 1バウンド目OK
    judge.onEvent(hitEvent('player'), makeBall({}))
    judge.onEvent(bounceEvent(0, -5.0), makeBall({ bounceCount: 1 }))

    // opponent が返さない → 2バウンド目
    const ball = makeBall({ bounceCount: 2 })
    const verdict = judge.onEvent(bounceEvent(0, -5.0), ball)
    expect(verdict).not.toBeNull()
    expect(verdict?.reason).toBe('doubleBounce')
    expect(verdict?.winner).toBe('player') // 直前の打者(player)の得点
  })

  it('player コートで2バウンド → player 失点(doubleBounce)', () => {
    judge.reset('player', PLAYER_SERVE_BOX)
    judge.onEvent(bounceEvent(COURT_HALF_WIDTH / 2, -(SERVICE_LINE_Z / 2)), makeBall({ bounceCount: 1 }))

    // opponent がラリーショット → player コートにバウンド → 1バウンド目
    judge.onEvent(hitEvent('opponent'), makeBall({}))
    judge.onEvent(bounceEvent(0, 5.0), makeBall({ bounceCount: 1 }))

    // player が返さない → 2バウンド目
    const ball = makeBall({ bounceCount: 2 })
    const verdict = judge.onEvent(bounceEvent(0, 5.0), ball)
    expect(verdict).not.toBeNull()
    expect(verdict?.reason).toBe('doubleBounce')
    expect(verdict?.winner).toBe('opponent') // 直前の打者(opponent)の得点
  })
})

// ---------------------------------------------------------------------------
// ネットイベント(即決着にはしない)
// ---------------------------------------------------------------------------

describe('RallyJudge — ネット後の処理', () => {
  it('net イベントのみでは決着しない(null)', () => {
    judge.reset('player', PLAYER_SERVE_BOX)
    // サーブ成功してラリーへ
    judge.onEvent(bounceEvent(COURT_HALF_WIDTH / 2, -(SERVICE_LINE_Z / 2)), makeBall({ bounceCount: 1 }))

    judge.onEvent(hitEvent('player'), makeBall({}))
    const verdict = judge.onEvent(netEvent, makeBall({}))
    expect(verdict).toBeNull()
  })

  it('ネット後に自陣でバウンドすると失点(net reason)', () => {
    judge.reset('player', PLAYER_SERVE_BOX)
    judge.onEvent(bounceEvent(COURT_HALF_WIDTH / 2, -(SERVICE_LINE_Z / 2)), makeBall({ bounceCount: 1 }))

    // player がショット → ネット → 自陣(player 側)にバウンド
    judge.onEvent(hitEvent('player'), makeBall({}))
    judge.onEvent(netEvent, makeBall({}))
    const ball = makeBall({ bounceCount: 1 })
    const verdict = judge.onEvent(bounceEvent(0, 3.0), ball) // z>0 = player 自陣
    expect(verdict).not.toBeNull()
    expect(verdict?.winner).toBe('opponent')
    expect(verdict?.reason).toBe('net')
  })
})

// ---------------------------------------------------------------------------
// 場外飛出し(update による検出)
// ---------------------------------------------------------------------------

describe('RallyJudge — 場外飛出し', () => {
  it('|x| > OUT_BOUND_X で場外 → out', () => {
    judge.reset('player', PLAYER_SERVE_BOX)
    judge.onEvent(bounceEvent(COURT_HALF_WIDTH / 2, -(SERVICE_LINE_Z / 2)), makeBall({ bounceCount: 1 }))
    judge.onEvent(hitEvent('player'), makeBall({}))

    const ball = makeBall({ x: 10.0, z: -5.0, inPlay: true })
    const verdict = judge.update(ball)
    expect(verdict).not.toBeNull()
    expect(verdict?.reason).toBe('out')
  })

  it('|z| > OUT_BOUND_Z で場外 → out', () => {
    judge.reset('player', PLAYER_SERVE_BOX)
    judge.onEvent(bounceEvent(COURT_HALF_WIDTH / 2, -(SERVICE_LINE_Z / 2)), makeBall({ bounceCount: 1 }))
    judge.onEvent(hitEvent('player'), makeBall({}))

    const ball = makeBall({ x: 0, z: -17.0, inPlay: true })
    const verdict = judge.update(ball)
    expect(verdict).not.toBeNull()
    expect(verdict?.reason).toBe('out')
    expect(verdict?.winner).toBe('opponent') // player が打った → opponent が winner
  })

  it('inPlay=false なら update は null を返す', () => {
    judge.reset('player', PLAYER_SERVE_BOX)
    const ball = makeBall({ x: 10.0, z: 0, inPlay: false })
    const verdict = judge.update(ball)
    expect(verdict).toBeNull()
  })

  it('1バウンド済み(イン)で場外へ抜けたら打者のウィナー(§8 規則5)', () => {
    judge.reset('player', PLAYER_SERVE_BOX)
    judge.onEvent(bounceEvent(COURT_HALF_WIDTH / 2, -(SERVICE_LINE_Z / 2)), makeBall({ bounceCount: 1 }))
    judge.onEvent(hitEvent('opponent'), makeBall({}))
    // opponent の返球が player コートにイン(決着なし)
    const inBounce = judge.onEvent(bounceEvent(2.0, 10.0), makeBall({ bounceCount: 1 }))
    expect(inBounce).toBeNull()
    // player が触れず、バウンド後にボールが場外境界を越えた
    const ball = makeBall({ x: 2.0, z: 16.5, bounceCount: 1, lastHitBy: 'opponent' })
    const verdict = judge.update(ball)
    expect(verdict?.reason).toBe('winner')
    expect(verdict?.winner).toBe('opponent')
  })
})

// ---------------------------------------------------------------------------
// winner reason(相手が一度も触れず2バウンド)
// ---------------------------------------------------------------------------

describe('RallyJudge — winner reason', () => {
  it('player のサーブがサービスボックスに入り、opponent が触れずに2バウンド → winner', () => {
    judge.reset('player', PLAYER_SERVE_BOX)
    // サーブ(bounceCount=1でボックス内)
    judge.onEvent(bounceEvent(COURT_HALF_WIDTH / 2, -(SERVICE_LINE_Z / 2)), makeBall({ bounceCount: 1 }))

    // opponent は打たずに2バウンド(opponent のラリーショットがない)
    // lastHitter = player(サーブ時に設定)のまま
    // 2バウンド目が来たら doubleBounce = player の得点
    const ball = makeBall({ bounceCount: 2 })
    const verdict = judge.onEvent(bounceEvent(0, -5.0), ball)
    expect(verdict?.reason).toBe('doubleBounce')
    expect(verdict?.winner).toBe('player')
  })

  it('ラリーで opponent が返せずに2バウンド → winner(player の得点)', () => {
    judge.reset('player', PLAYER_SERVE_BOX)
    judge.onEvent(bounceEvent(COURT_HALF_WIDTH / 2, -(SERVICE_LINE_Z / 2)), makeBall({ bounceCount: 1 }))

    // ラリー継続: opponent が打って player コートへ → player が打って opponent コートへ
    judge.onEvent(hitEvent('opponent'), makeBall({}))
    judge.onEvent(bounceEvent(0, 5.0), makeBall({ bounceCount: 1 }))
    judge.onEvent(hitEvent('player'), makeBall({}))

    // 1バウンド目: opponent コートにイン
    judge.onEvent(bounceEvent(0, -5.0), makeBall({ bounceCount: 1 }))

    // opponent が返せない → 2バウンド目(winner)
    const ball = makeBall({ bounceCount: 2 })
    const verdict = judge.onEvent(bounceEvent(0, -5.0), ball)
    expect(verdict?.reason).toBe('doubleBounce')
    expect(verdict?.winner).toBe('player')
  })
})

// ---------------------------------------------------------------------------
// BUG-001: サーブをノーバウンドで返球すると通常ラリーへ移行する
// ---------------------------------------------------------------------------

describe('RallyJudge — サーブのノーバウンド返球(BUG-001)', () => {
  it('レシーバーがサーブをノーバウンドで返すと、返球の着地はフォルトでなく通常判定になる', () => {
    // player サーブ
    judge.reset('player', PLAYER_SERVE_BOX)
    judge.onEvent(hitEvent('player'), makeBall({})) // サーブ打球(by=server)
    // レシーバー(opponent)がノーバウンドで返球(サーブはまだ bounce していない)
    const v1 = judge.onEvent(hitEvent('opponent'), makeBall({}))
    expect(v1).toBeNull()
    // 返球が player コート内に着地 → フォルトではなく通常ラリーのイン(決着なし)
    const v2 = judge.onEvent(bounceEvent(2.0, 8.0), makeBall({ bounceCount: 1, lastHitBy: 'opponent' }))
    expect(v2).toBeNull() // フォルトが出ない
  })

  it('返球がアウトなら out(フォルトではない)', () => {
    judge.reset('player', PLAYER_SERVE_BOX)
    judge.onEvent(hitEvent('player'), makeBall({}))
    judge.onEvent(hitEvent('opponent'), makeBall({}))
    // 返球が player コート外(ベースライン奥)に着地 → out(打った opponent の失点)
    const v = judge.onEvent(bounceEvent(2.0, COURT_HALF_LENGTH + 1), makeBall({ bounceCount: 1, lastHitBy: 'opponent' }))
    expect(v?.reason).toBe('out')
    expect(v?.winner).toBe('player')
  })
})

// ---------------------------------------------------------------------------
// reset で状態が正しくリセットされる
// ---------------------------------------------------------------------------

describe('RallyJudge — reset', () => {
  it('reset 後は新たなサーブフェーズとして動作する', () => {
    // 1ポイント目: player サーブ
    judge.reset('player', PLAYER_SERVE_BOX)
    judge.onEvent(bounceEvent(COURT_HALF_WIDTH / 2, -(SERVICE_LINE_Z / 2)), makeBall({ bounceCount: 1 }))

    // 2ポイント目: opponent サーブにリセット
    judge.reset('opponent', OPPONENT_SERVE_BOX)
    // opponent コートのサービスボックス内(z>0)にバウンド
    const ball = makeBall({ bounceCount: 1 })
    const verdict = judge.onEvent(bounceEvent(COURT_HALF_WIDTH / 2, SERVICE_LINE_Z / 2), ball)
    expect(verdict).toBeNull() // イン → ラリー継続
  })
})
