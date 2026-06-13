// =============================================================================
// スコアリング — テニスのポイント・ゲーム管理
// 仕様: docs/ARCHITECTURE.md §9、docs/GAME_DESIGN.md §2
// =============================================================================
import type { Side, ScoreView } from '../types'
import { otherSide } from '../types'

// ---------------------------------------------------------------------------
// ポイント進行の内部表現
// 通常: 0→1→2→3→4(ゲーム)、デュース時: 3=40-40、4=アドバンテージ
// ---------------------------------------------------------------------------

/** ポイントの内部インデックス(0=0点, 1=15, 2=30, 3=40, 4=Ad) */
type PointIndex = 0 | 1 | 2 | 3 | 4

/** ポイントインデックスを表示文字列に変換 */
function pointLabel(idx: PointIndex): string {
  switch (idx) {
    case 0: return '0'
    case 1: return '15'
    case 2: return '30'
    case 3: return '40'
    case 4: return 'Ad'
  }
}

// ---------------------------------------------------------------------------
// MatchScore クラス
// ---------------------------------------------------------------------------

/**
 * テニスのスコアを管理するクラス。
 * 15/30/40/デュース/アドバンテージのポイント、ゲーム数、サーブ権を追跡する。
 */
export class MatchScore {
  /** 先取ゲーム数 */
  private readonly gamesToWin: 1 | 2 | 4

  /** 現在のポイントインデックス(player, opponent) */
  private pts: { player: PointIndex; opponent: PointIndex } = { player: 0, opponent: 0 }

  /** 獲得ゲーム数 */
  private gms: { player: number; opponent: number } = { player: 0, opponent: 0 }

  /** 現在のサーバー(最初はプレイヤー。ゲームごとに交代) */
  private _server: Side = 'player'

  /** 最後の addPoint でゲームが決まった側(なければ null) */
  private _gameJustWon: Side | null = null

  /** マッチ勝者(未決着なら null) */
  private _matchWinner: Side | null = null

  constructor(gamesToWin: 1 | 2 | 4) {
    this.gamesToWin = gamesToWin
  }

  /**
   * 指定した側がポイントを取得したときに呼ぶ。
   * デュース・アドバンテージ・ゲーム取得・マッチ終了まで自動処理する。
   */
  addPoint(side: Side): void {
    // マッチが終わっていれば何もしない
    if (this._matchWinner !== null) return

    this._gameJustWon = null

    const other = otherSide(side)

    const myPts = this.pts[side]
    const opPts = this.pts[other]

    // デュース状態(双方40)
    if (myPts === 3 && opPts === 3) {
      // デュースから +1 でアドバンテージ
      this.pts[side] = 4
      return
    }

    // アドバンテージ持ちのプレイヤーがポイントを取った → ゲーム
    if (myPts === 4) {
      this._winGame(side)
      return
    }

    // アドバンテージを相手が持っていて自分がポイント → デュースに戻る
    if (opPts === 4) {
      this.pts[other] = 3
      return
    }

    // 40(3) でポイントを取った → ゲーム
    if (myPts === 3) {
      this._winGame(side)
      return
    }

    // 通常進行: 0→1→2→3
    this.pts[side] = (myPts + 1) as PointIndex
  }

  /** ゲームを取得する処理 */
  private _winGame(side: Side): void {
    // ポイントをリセット
    this.pts = { player: 0, opponent: 0 }

    // ゲーム数を加算
    this.gms[side] += 1

    this._gameJustWon = side

    // サーブ権を交代
    this._server = otherSide(this._server)

    // マッチ終了チェック
    if (this.gms[side] >= this.gamesToWin) {
      this._matchWinner = side
    }
  }

  /** 現在のスコアビューを返す(readonly スナップショット) */
  get view(): ScoreView {
    return {
      points: {
        player: pointLabel(this.pts.player),
        opponent: pointLabel(this.pts.opponent),
      },
      games: { ...this.gms },
      server: this._server,
      gameJustWon: this._gameJustWon,
      matchWinner: this._matchWinner,
    }
  }
}
