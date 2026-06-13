// =============================================================================
// ラリー判定 — BallEvent ストリームからポイント帰属を決定する
// 仕様: docs/ARCHITECTURE.md §8
// =============================================================================
import { Vector3 } from 'three'
import type { Side, BallEvent, BallState, RallyVerdict, ServiceBox } from '../types'
import { otherSide, sideSign } from '../types'
import {
  COURT_HALF_LENGTH,
  COURT_HALF_WIDTH,
  SERVICE_LINE_Z,
  BALL_RADIUS,
  OUT_BOUND_X,
  OUT_BOUND_Z,
} from '../constants'

// ---------------------------------------------------------------------------
// 内部状態の型
// ---------------------------------------------------------------------------

/**
 * ラリーのフェーズ。
 * - 'serve': サーブ中。1バウンド目はサービスボックス判定を行う
 * - 'rally': 通常ラリー中
 */
type RallyPhase = 'serve' | 'rally'

// ---------------------------------------------------------------------------
// ユーティリティ: イン/アウト判定
// ---------------------------------------------------------------------------

/**
 * ボール中心(x, z)がシングルスコート内ならtrue。
 * 判定: |x| <= COURT_HALF_WIDTH + BALL_RADIUS かつ |z| <= COURT_HALF_LENGTH + BALL_RADIUS
 * (ライン外縁 + BALL_RADIUS 以内ならイン)
 */
function isInCourt(x: number, z: number): boolean {
  return (
    Math.abs(x) <= COURT_HALF_WIDTH + BALL_RADIUS &&
    Math.abs(z) <= COURT_HALF_LENGTH + BALL_RADIUS
  )
}

/**
 * ボール中心がサービスボックス内ならtrue。
 * サービスボックスは受け手コートのネット側半分(|z| ∈ [BALL_RADIUS, SERVICE_LINE_Z + BALL_RADIUS])
 * かつ xMin <= x <= xMax(センターライン〜サイドライン)。
 */
function isInServiceBox(x: number, z: number, box: ServiceBox): boolean {
  // z 方向: 受け手コートのネット〜サービスラインの間
  // box.zSign は受け手コートの z 符号
  const zAbs = z * box.zSign // 受け手コートでは正の値になる
  const zMin = BALL_RADIUS // ネット際
  const zMax = SERVICE_LINE_Z + BALL_RADIUS // サービスライン外縁

  if (zAbs < zMin || zAbs > zMax) return false

  // x 方向: box.xMin <= |x| <= box.xMax (センターライン〜サイドライン)
  // ただし box.xMin/xMax の符号も考慮する
  // xMin は常に ≥ 0 として設計されているため絶対値で比較
  if (x < box.xMin - BALL_RADIUS || x > box.xMax + BALL_RADIUS) return false

  return true
}

/**
 * 指定した Side のコート側に z 座標があるか確認する。
 * player(z>0)側か opponent(z<0)側か。
 * ネット上(z=0付近)は「どちらでもない」として false を返す。
 */
function isOnSide(z: number, side: Side): boolean {
  const sign = sideSign(side)
  return z * sign > 0
}

// ---------------------------------------------------------------------------
// RallyJudge クラス
// ---------------------------------------------------------------------------

/**
 * ラリー判定クラス。
 * BallEvent ストリームとボール状態から RallyVerdict を返す。
 *
 * 呼び出し方:
 *   judge.reset(server, serveTargetBox)  // 各ポイント開始時
 *   onEvent(e, ball)                     // 物理ステップから BallEvent が来るたびに
 *   update(ball)                         // 毎フレーム(場外飛出し検出)
 */
export class RallyJudge {
  /** 現在のラリーフェーズ */
  private phase: RallyPhase = 'rally'

  /** サービスボックス(サーブフェーズ時のみ使用) */
  private serveTargetBox: ServiceBox | null = null

  /** このラリーでの最後の打者(最後に hit イベントを発した側) */
  private lastHitter: Side | null = null

  /** このポイントのサーバー(サーブフェーズの判定・ノーバウンド返球の検出に使う) */
  private server: Side | null = null

  /** ネットイベントが発生したか(次のバウンス判定に使う) */
  private _netHit: boolean = false

  // ---------------------------------------------------------------------------
  // 公開 API
  // ---------------------------------------------------------------------------

  /**
   * 各ポイントの開始時に呼ぶ。状態をリセットする。
   * @param server サーバー側
   * @param serveTargetBox サーバーから見て対角のサービスボックス
   */
  reset(server: Side, serveTargetBox: ServiceBox): void {
    this.phase = 'serve'
    this.serveTargetBox = serveTargetBox
    this.lastHitter = server
    this.server = server
    this._netHit = false
  }

  /**
   * BallEvent を受け取り、決着があれば RallyVerdict を返す。
   * 決着がなければ null を返す。
   * @param e BallEvent
   * @param ball 現在のボール状態
   */
  onEvent(e: BallEvent, ball: BallState): RallyVerdict | null {
    if (e.kind === 'hit') {
      // サーブフェーズ中にレシーバー(サーバー以外)が打った = サーブを
      // ノーバウンド(ボレー)で返球した。サーブは成立として通常ラリーへ移行する
      // (BUG-001: 移行しないと返球後の着地がサーブのフォルト判定として誤処理される)。
      if (this.phase === 'serve' && this.server !== null && e.by !== this.server) {
        this.phase = 'rally'
      }
      // ヒットイベント: 打者を更新
      this.lastHitter = e.by
      this._netHit = false
      return null
    }

    if (e.kind === 'net') {
      // ネットイベント: 即決着にはしない。次のバウンスで規則1が適用される
      this._netHit = true
      return null
    }

    if (e.kind === 'bounce') {
      return this._handleBounce(e.pos, ball)
    }

    return null
  }

  /**
   * 毎フレーム呼ぶ。場外飛出し検出を行う。
   * @param ball 現在のボール状態
   */
  update(ball: BallState): RallyVerdict | null {
    if (!ball.inPlay) return null

    // 場外境界(|x|>OUT_BOUND_X or |z|>OUT_BOUND_Z)を超えた場合
    const x = ball.pos.x
    const z = ball.pos.z

    if (Math.abs(x) > OUT_BOUND_X || Math.abs(z) > OUT_BOUND_Z) {
      const hitter = this.lastHitter ?? 'player'
      // 既に1バウンド済み(その時点で決着していない = イン)なら、
      // 相手が触れずに場外へ抜けた打者のウィナー(ARCHITECTURE §8 規則5)
      if (ball.bounceCount >= 1) {
        return {
          winner: hitter,
          reason: 'winner',
        }
      }
      // バウンドが起きる前に場外に飛んだ → 打った側の失点
      return {
        winner: otherSide(hitter),
        reason: 'out',
      }
    }

    return null
  }

  // ---------------------------------------------------------------------------
  // 内部: バウンス判定ロジック
  // ---------------------------------------------------------------------------

  private _handleBounce(bouncePos: Vector3, ball: BallState): RallyVerdict | null {
    const x = bouncePos.x
    const z = bouncePos.z
    const hitter = this.lastHitter

    // lastHitter が null はゲーム開始前のはずなので安全ガード
    if (hitter === null) return null

    const receiver = otherSide(hitter)

    // --- サーブフェーズ処理 ---
    if (this.phase === 'serve') {
      return this._handleServeBounce(x, z, hitter)
    }

    // --- 通常ラリー処理 ---
    return this._handleRallyBounce(x, z, bouncePos, ball, hitter, receiver)
  }

  /**
   * サーブフェーズのバウンス判定。
   * 1バウンド目がサービスボックス内ならラリー継続、外ならfault。
   */
  private _handleServeBounce(
    x: number,
    z: number,
    server: Side,
  ): RallyVerdict | null {
    if (this.serveTargetBox === null) return null

    const box = this.serveTargetBox

    // サーブが受け手コートに着地しているか確認
    if (!isOnSide(z, otherSide(server))) {
      // 自陣や場外にバウンド → fault
      // (ネット後に自陣にバウンドするケースも含む)
      this.phase = 'rally' // 次のポイントのためにリセット
      return {
        winner: otherSide(server), // サーブフォルトの fault は相手が winner
        reason: 'fault',
      }
    }

    // サービスボックス判定
    const inBox = isInServiceBox(x, z, box)

    if (!inBox) {
      this.phase = 'rally'
      return {
        winner: otherSide(server),
        reason: 'fault',
      }
    }

    // サービスボックス内にバウンド → 通常ラリーへ移行
    this.phase = 'rally'
    return null
  }

  /**
   * 通常ラリーのバウンス判定。
   * ARCHITECTURE §8 の規則に従う。
   */
  private _handleRallyBounce(
    x: number,
    z: number,
    _bouncePos: Vector3,
    ball: BallState,
    hitter: Side,
    receiver: Side,
  ): RallyVerdict | null {
    const bounceCount = ball.bounceCount

    // bounceCount は「最後の打球以降の地面バウンド数」。
    // BallSim.step はバウンス後に bounceCount をインクリメントしてからイベントを返すと想定する。
    // ただし実装差に備え、バウンス順番は内部カウンタで管理する。
    // onEvent の呼び出し順から bounceCount = 1 が1バウンド目、2が2バウンド目。

    if (bounceCount === 1) {
      // --- 1バウンド目 ---
      // 規則1: H の自陣側(hitter 側)にバウンド → H の失点
      if (isOnSide(z, hitter)) {
        return {
          winner: receiver,
          reason: 'net', // ネットを越えずに自陣バウンド
        }
      }

      // 規則2: receiver コートにバウンドした場合
      // コート外か確認
      if (!isInCourt(x, z)) {
        return {
          winner: receiver,
          reason: 'out',
        }
      }

      // コート内 → ラリー継続
      return null
    }

    if (bounceCount >= 2) {
      // --- 2バウンド目以降 ---
      // 規則3: receiver が返せなかった → hitter の得点(doubleBounce)
      return {
        winner: hitter,
        reason: 'doubleBounce',
      }
    }

    return null
  }
}
