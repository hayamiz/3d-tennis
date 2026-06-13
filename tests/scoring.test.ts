// =============================================================================
// スコアリングの単体テスト
// 仕様: docs/ARCHITECTURE.md §9、§16
// =============================================================================
import { describe, it, expect, beforeEach } from 'vitest'
import { MatchScore } from '../src/core/scoring'
import type { Side } from '../src/types'

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------

/** n ポイントを指定側に加算するショートハンド */
function addPoints(score: MatchScore, side: Side, n: number): void {
  for (let i = 0; i < n; i++) score.addPoint(side)
}

// ---------------------------------------------------------------------------
// 基本ポイント進行
// ---------------------------------------------------------------------------

describe('MatchScore — ポイント進行', () => {
  it('初期状態は 0-0', () => {
    const score = new MatchScore(2)
    const v = score.view
    expect(v.points.player).toBe('0')
    expect(v.points.opponent).toBe('0')
    expect(v.games.player).toBe(0)
    expect(v.games.opponent).toBe(0)
    expect(v.server).toBe('player')
    expect(v.matchWinner).toBeNull()
    expect(v.gameJustWon).toBeNull()
  })

  it('0 → 15 → 30 → 40 と進む', () => {
    const score = new MatchScore(2)
    score.addPoint('player')
    expect(score.view.points.player).toBe('15')
    score.addPoint('player')
    expect(score.view.points.player).toBe('30')
    score.addPoint('player')
    expect(score.view.points.player).toBe('40')
  })

  it('40 でポイントを取るとゲーム取得', () => {
    const score = new MatchScore(2)
    addPoints(score, 'player', 4) // 0→15→30→40→ゲーム
    const v = score.view
    expect(v.points.player).toBe('0') // ポイントリセット
    expect(v.points.opponent).toBe('0')
    expect(v.games.player).toBe(1)
    expect(v.gameJustWon).toBe('player')
  })

  it('ゲーム取得後にサーブ権が交代する', () => {
    const score = new MatchScore(2)
    expect(score.view.server).toBe('player')
    addPoints(score, 'player', 4) // プレイヤーがゲーム取得
    expect(score.view.server).toBe('opponent') // サーブ権交代
  })

  it('ゲーム取得後 gameJustWon は次の addPoint でリセットされる', () => {
    const score = new MatchScore(2)
    addPoints(score, 'player', 4)
    expect(score.view.gameJustWon).toBe('player')
    score.addPoint('opponent')
    expect(score.view.gameJustWon).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// デュース・アドバンテージ
// ---------------------------------------------------------------------------

describe('MatchScore — デュース・アドバンテージ', () => {
  it('40-40 でデュース状態になる', () => {
    const score = new MatchScore(2)
    addPoints(score, 'player', 3)   // player 40
    addPoints(score, 'opponent', 3) // opponent 40 → デュース
    expect(score.view.points.player).toBe('40')
    expect(score.view.points.opponent).toBe('40')
  })

  it('デュースから +1 でアドバンテージ', () => {
    const score = new MatchScore(2)
    addPoints(score, 'player', 3)
    addPoints(score, 'opponent', 3)
    score.addPoint('player') // player Ad
    expect(score.view.points.player).toBe('Ad')
    expect(score.view.points.opponent).toBe('40')
  })

  it('アドバンテージから +1 でゲーム取得', () => {
    const score = new MatchScore(2)
    addPoints(score, 'player', 3)
    addPoints(score, 'opponent', 3)
    score.addPoint('player') // Ad
    score.addPoint('player') // ゲーム
    expect(score.view.games.player).toBe(1)
    expect(score.view.gameJustWon).toBe('player')
  })

  it('アドバンテージ持ちが失点するとデュースに戻る', () => {
    const score = new MatchScore(2)
    addPoints(score, 'player', 3)
    addPoints(score, 'opponent', 3)
    score.addPoint('player') // player Ad
    score.addPoint('opponent') // デュースに戻る
    expect(score.view.points.player).toBe('40')
    expect(score.view.points.opponent).toBe('40')
  })

  it('デュースを3往復してからゲーム取得できる', () => {
    const score = new MatchScore(2)
    addPoints(score, 'player', 3)
    addPoints(score, 'opponent', 3)
    // 往復1
    score.addPoint('player')   // player Ad
    score.addPoint('opponent') // deuce
    // 往復2
    score.addPoint('opponent') // opponent Ad
    score.addPoint('player')   // deuce
    // 往復3
    score.addPoint('player')   // player Ad
    score.addPoint('player')   // ゲーム取得
    expect(score.view.games.player).toBe(1)
  })

  it('opponent がアドバンテージを取ってゲームを取れる', () => {
    const score = new MatchScore(2)
    addPoints(score, 'player', 3)
    addPoints(score, 'opponent', 3)
    score.addPoint('opponent') // opponent Ad
    score.addPoint('opponent') // ゲーム
    expect(score.view.games.opponent).toBe(1)
    expect(score.view.gameJustWon).toBe('opponent')
  })
})

// ---------------------------------------------------------------------------
// マッチ決着
// ---------------------------------------------------------------------------

describe('MatchScore — マッチ決着', () => {
  it('gamesToWin=1: 1ゲーム先取でマッチ終了', () => {
    const score = new MatchScore(1)
    addPoints(score, 'player', 4)
    expect(score.view.matchWinner).toBe('player')
  })

  it('gamesToWin=2: 2ゲーム先取でマッチ終了', () => {
    const score = new MatchScore(2)
    addPoints(score, 'player', 4)  // ゲーム1
    addPoints(score, 'player', 4)  // ゲーム2 → マッチ終了
    expect(score.view.matchWinner).toBe('player')
    expect(score.view.games.player).toBe(2)
  })

  it('gamesToWin=4: 4ゲーム先取でマッチ終了', () => {
    const score = new MatchScore(4)
    for (let i = 0; i < 4; i++) {
      addPoints(score, 'opponent', 4)
    }
    expect(score.view.matchWinner).toBe('opponent')
    expect(score.view.games.opponent).toBe(4)
  })

  it('マッチ終了後は addPoint を呼んでも変化しない', () => {
    const score = new MatchScore(1)
    addPoints(score, 'player', 4)
    expect(score.view.matchWinner).toBe('player')

    // マッチ後にさらにポイントを追加しても変化しない
    addPoints(score, 'opponent', 10)
    expect(score.view.matchWinner).toBe('player')
    expect(score.view.games.player).toBe(1)
    expect(score.view.games.opponent).toBe(0)
  })

  it('gamesToWin=2: 1-1 の後に相手がマッチを取る', () => {
    const score = new MatchScore(2)
    addPoints(score, 'player', 4)   // player ゲーム1
    addPoints(score, 'opponent', 4) // opponent ゲーム1
    addPoints(score, 'opponent', 4) // opponent ゲーム2 → マッチ終了
    expect(score.view.matchWinner).toBe('opponent')
    expect(score.view.games.player).toBe(1)
    expect(score.view.games.opponent).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// サーブ権
// ---------------------------------------------------------------------------

describe('MatchScore — サーブ権交代', () => {
  it('ゲームごとにサーブ権が交代する(player→opponent→player)', () => {
    const score = new MatchScore(4)
    expect(score.view.server).toBe('player')
    addPoints(score, 'player', 4)   // ゲーム1 player取得
    expect(score.view.server).toBe('opponent')
    addPoints(score, 'opponent', 4) // ゲーム2 opponent取得
    expect(score.view.server).toBe('player')
    addPoints(score, 'player', 4)   // ゲーム3 player取得
    expect(score.view.server).toBe('opponent')
  })

  it('デュースをはさんでゲーム取得してもサーブ権が交代する', () => {
    const score = new MatchScore(2)
    addPoints(score, 'player', 3)
    addPoints(score, 'opponent', 3)
    score.addPoint('player')
    score.addPoint('opponent') // deuce
    score.addPoint('player')
    score.addPoint('player') // player ゲーム取得
    expect(score.view.server).toBe('opponent')
  })
})
