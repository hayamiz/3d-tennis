// =============================================================================
// 効果音モジュール — WebAudio API による合成音
// 外部アセット不使用。OscillatorNode + ノイズバッファ + BiquadFilter + ConvolverNode で生成。
// 打球音は playHit(shot, opts) に集約。bounce/net/point/applause/ui は play(name) で扱う。
// =============================================================================
import type { SfxName, ShotType } from '../types'
import {
  HIT_SAMPLE_BRIGHTEN,
  HIT_SAMPLE_GAIN,
  HIT_SAMPLE_MISHIT_LPF,
  HIT_SAMPLE_MISHIT_RATE,
  HIT_SAMPLE_RATE,
  HIT_SAMPLE_SERVE_RATE,
  HIT_SOUND_PARAMS,
  SFX_HIT_BODY_BRIGHTEN,
  SFX_HIT_CLICK_HZ,
  SFX_HIT_PITCH_JITTER,
  SFX_HIT_SHIMMER_MUL,
  SFX_JUST_BELL_GAIN,
  SFX_JUST_Q_MUL,
  SFX_MISHIT_NOISE_MUL,
  SFX_MISHIT_Q_MUL,
  SFX_REVERB_SECONDS,
  SFX_REVERB_WET,
  SFX_SERVE_DECAY_MUL,
  SFX_SERVE_GAIN_MUL,
} from '../constants'
// 打球音サンプル(効果音ラボ「テニスラケットで打つ」)。Vite が URL 文字列に解決する。
// ランタイムで外部URLを直リンクせず、ビルドに同梱した自前ホストの音源を読む。
import tennisRacket1Url from './samples/tennis-racket1.mp3'
import tennisRacket2Url from './samples/tennis-racket2.mp3'

// ---------------------------------------------------------------------------
// 内部定数
// ---------------------------------------------------------------------------

/** マスターゲイン(同時発音での音割れ防止のため控えめな値) */
const MASTER_GAIN = 0.5

/** ホワイトノイズバッファのサンプル数(~0.5秒分、44100Hz 想定) */
const NOISE_BUF_SAMPLES = 22050

/** playHit の intensity 下限(0 に近いと無音になるため) */
const INTENSITY_MIN = 0.4

// ---------------------------------------------------------------------------
// ヘルパー: 短い Envelope(attackTime → decayTime で 0 に落とす)
// ---------------------------------------------------------------------------

/**
 * GainNode を使ってエンベロープを設定する。
 * @param gainNode   - 対象 GainNode
 * @param ctx        - AudioContext
 * @param peak       - ピークゲイン値
 * @param attackTime - アタック時間(秒)
 * @param decayTime  - ディケイ時間(秒)
 */
function applyEnvelope(
  gainNode: GainNode,
  ctx: AudioContext,
  peak: number,
  attackTime: number,
  decayTime: number,
): void {
  const now = ctx.currentTime
  gainNode.gain.setValueAtTime(0, now)
  gainNode.gain.linearRampToValueAtTime(peak, now + attackTime)
  gainNode.gain.exponentialRampToValueAtTime(0.0001, now + attackTime + decayTime)
}

// ---------------------------------------------------------------------------
// Sfx クラス
// ---------------------------------------------------------------------------

/**
 * WebAudio 合成による効果音クラス。
 * AudioContext は遅延生成(初回 resume() 呼び出し時に作成)。
 * resume() 前に play()/playHit() が呼ばれても例外は出さず無視する。
 */
export class Sfx {
  /** AudioContext。resume() 前は null */
  private ctx: AudioContext | null = null
  /** マスターゲインノード */
  private master: GainNode | null = null
  /** 使い回すホワイトノイズバッファ */
  private noiseBuf: AudioBuffer | null = null
  /** 残響用 ConvolverNode(resume() 時に手続き生成した IR をセット) */
  private convolver: ConvolverNode | null = null
  /** 残響ウェットゲイン(convolver → master に薄く送る) */
  private reverbWet: GainNode | null = null
  /** デコード済み打球音サンプル(複数=ラウンドロビンで反復感を消す)。空なら合成にフォールバック */
  private hitBuffers: AudioBuffer[] = []
  /** サンプルのロードを一度だけ開始するためのフラグ */
  private hitLoadStarted = false
  /** ラウンドロビン用カウンタ */
  private hitRR = 0

  // ---------------------------------------------------------------------------
  // 公開 API
  // ---------------------------------------------------------------------------

  /**
   * 初回ユーザー操作時に呼ぶ。
   * AudioContext を生成(または resume)し、ノイズバッファと残響 IR を初期化する。
   */
  resume(): void {
    if (!this.ctx) {
      // AudioContext 生成
      this.ctx = new AudioContext()

      // マスターゲイン設定
      this.master = this.ctx.createGain()
      this.master.gain.value = MASTER_GAIN
      this.master.connect(this.ctx.destination)

      // ホワイトノイズバッファを1回だけ生成して使い回す
      this.noiseBuf = this.createNoiseBuf(this.ctx)

      // 手続き生成のインパルス応答で残響ノードを初期化する
      this.convolver = this.ctx.createConvolver()
      this.convolver.buffer = this.createReverbIR(this.ctx)
      this.reverbWet = this.ctx.createGain()
      this.reverbWet.gain.value = SFX_REVERB_WET
      this.convolver.connect(this.reverbWet)
      this.reverbWet.connect(this.master)

      // 打球音サンプルを非同期ロード(完了までは合成音で鳴る)
      void this.loadHitSamples(this.ctx)
    }

    // iOS Safari 等では suspended 状態になることがあるため resume
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume()
    }
  }

  /**
   * 打球音サンプル(効果音ラボ)を取得しデコードして hitBuffers に格納する。
   * ネットワーク/デコード失敗時は黙って合成音にフォールバックする(例外を投げない)。
   */
  private async loadHitSamples(ctx: AudioContext): Promise<void> {
    if (this.hitLoadStarted) return
    this.hitLoadStarted = true
    const urls = [tennisRacket2Url, tennisRacket1Url] // [0]=「パコッ」を主に
    try {
      const buffers = await Promise.all(
        urls.map(async (url) => {
          const res = await fetch(url)
          const arr = await res.arrayBuffer()
          return await ctx.decodeAudioData(arr)
        }),
      )
      this.hitBuffers = buffers
    } catch {
      // 失敗時は合成音のまま(hitBuffers は空)
      this.hitBuffers = []
    }
  }

  /**
   * 効果音を再生する(打球以外専用)。
   * 対応: bounce / net / point / applause / ui
   * @param name  - 再生する効果音の識別子
   * @param opts  - intensity 0..1(デフォルト 1.0)。音量・ピッチの調整に使う。
   */
  play(name: SfxName, opts?: { intensity?: number }): void {
    // resume() 前または AudioContext 未準備なら無視
    if (!this.ctx || !this.master || !this.noiseBuf) return
    if (this.ctx.state === 'suspended') return

    const intensity = opts?.intensity ?? 1.0

    switch (name) {
      case 'bounce':
        this.playBounce(intensity)
        break
      case 'net':
        this.playNet(intensity)
        break
      case 'point':
        this.playPoint(intensity)
        break
      case 'applause':
        this.playApplause(intensity)
        break
      case 'ui':
        this.playUi(intensity)
        break
    }
  }

  /**
   * 打球音を再生する。**実録音サンプル(効果音ラボ「テニスラケットで打つ」)**が
   * ロード済みならそれを再生し、未ロード/失敗時は合成音(playHitSynth)へフォールバックする。
   * @param shot - ショット種別
   * @param opts - intensity 0..1 / panX -1..1 / serve / just / mishit(playHitSynth と共通)
   */
  playHit(
    shot: ShotType,
    opts?: { intensity?: number; panX?: number; serve?: boolean; just?: boolean; mishit?: boolean },
  ): void {
    if (!this.ctx || !this.master) return
    if (this.ctx.state === 'suspended') return
    if (this.hitBuffers.length > 0) this.playHitSample(shot, opts)
    else this.playHitSynth(shot, opts)
  }

  /**
   * サンプル再生: 実録音の打球音を BufferSource で鳴らし、playbackRate(音程)・
   * 音量・ステレオパンで加工してショット種別を描き分ける(規約上、改変利用は可)。
   * ラウンドロビンで複数サンプルを切り替え、微ピッチ揺らぎで反復感を消す。
   */
  private playHitSample(
    shot: ShotType,
    opts?: { intensity?: number; panX?: number; serve?: boolean; just?: boolean; mishit?: boolean },
  ): void {
    const ctx = this.ctx!
    const master = this.master!
    const intensity = Math.max(0, Math.min(1, opts?.intensity ?? 1.0))
    const panX = Math.max(-1, Math.min(1, opts?.panX ?? 0))
    const serve = opts?.serve ?? false
    const just = opts?.just ?? false
    const mishit = opts?.mishit ?? false

    // ラウンドロビンでサンプルを選択
    const buf = this.hitBuffers[this.hitRR % this.hitBuffers.length]
    this.hitRR++

    const src = ctx.createBufferSource()
    src.buffer = buf

    // 音程(playbackRate): ショット種別レート × 強打微増 × 微ジッタ。mishit/serve は専用レート。
    const jitter = 1 + (Math.random() * 2 - 1) * SFX_HIT_PITCH_JITTER
    let rate = mishit ? HIT_SAMPLE_MISHIT_RATE : serve ? HIT_SAMPLE_SERVE_RATE : HIT_SAMPLE_RATE[shot]
    rate *= jitter * (1 + (intensity - 0.6) * HIT_SAMPLE_BRIGHTEN)
    src.playbackRate.value = Math.max(0.25, rate)

    // 音量(強打ほど大きく)とステレオ定位
    const gain = ctx.createGain()
    gain.gain.value = HIT_SAMPLE_GAIN * (0.55 + 0.5 * intensity) * (serve ? SFX_SERVE_GAIN_MUL : 1)
    const panner = ctx.createStereoPanner()
    panner.pan.value = panX

    // チェーン: src →(mishit 時 lowpass で鈍く)→ gain → panner → master(+残響センド)
    let head: AudioNode = src
    if (mishit) {
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = HIT_SAMPLE_MISHIT_LPF
      src.connect(lp)
      head = lp
    }
    head.connect(gain)
    gain.connect(panner)
    panner.connect(master)
    if (this.convolver) panner.connect(this.convolver)
    src.start()

    // just: 澄んだベル倍音を一瞬重ね、スイートスポットのきらめきを足す
    if (just) {
      const bell = ctx.createOscillator()
      const bellEnv = ctx.createGain()
      bell.type = 'sine'
      bell.frequency.value = 2100
      bell.connect(bellEnv)
      bellEnv.connect(panner)
      const now = ctx.currentTime
      bellEnv.gain.setValueAtTime(0, now)
      bellEnv.gain.linearRampToValueAtTime(SFX_JUST_BELL_GAIN * intensity, now + 0.002)
      bellEnv.gain.exponentialRampToValueAtTime(0.0001, now + 0.08)
      bell.start(now)
      bell.stop(now + 0.1)
    }
  }

  /**
   * 【フォールバック】打球音を合成で鳴らす。サンプル未ロード/失敗時のみ使用。
   * ショット種別ごとにパラメータを切り替えてリアルタイム合成する。
   *
   * 実テニス打球音の "POCK!" を狙った 5 レイヤ合成:
   *   ① ボディ(pock): ピッチ降下する三角波。音程感のある芯=パンチ。
   *   ② クラック(アタック): 明るいハイパスノイズの鋭い立ち上がり。抜け・クリスプ感。
   *   ③ シマー: 1.8〜2.8kHz 帯のバンドパスノイズ。高域の煌めき(クリスプさ)。
   *   ④ 弦面リング: bodyHz の高Qバンドパスノイズの短い余韻。
   *   ⑤ ブラシ: 擦過ノイズ(スピン/スライスの sweep)。
   * 全レイヤを StereoPannerNode(panX) → master に通し、残響センド(ConvolverNode)にも薄く送る。
   *
   * @param shot  - ショット種別
   * @param opts  - 合成オプション
   *   - intensity 0..1(デフォルト 1.0): 球威/チャージ由来。強いほど明るく鋭く・大きい。
   *   - panX -1..1(デフォルト 0): ステレオ定位。打点の x 座標を渡す。
   *   - serve true: フラットを増強(SFX_SERVE_GAIN_MUL/DECAY_MUL 適用)。
   *   - just true: 最もクリアなリング(Q × SFX_JUST_Q_MUL) + ごく短いベル倍音。
   *   - mishit true: ボディを鈍く・ノイズ多め・詰まった「コツッ」(芯を外した感)。
   */
  private playHitSynth(
    shot: ShotType,
    opts?: { intensity?: number; panX?: number; serve?: boolean; just?: boolean; mishit?: boolean },
  ): void {
    // resume() 前または AudioContext 未準備なら無視
    if (!this.ctx || !this.master || !this.noiseBuf || !this.convolver || !this.reverbWet) return
    if (this.ctx.state === 'suspended') return

    const ctx = this.ctx
    const master = this.master
    const noiseBuf = this.noiseBuf
    const convolver = this.convolver

    const rawIntensity = opts?.intensity ?? 1.0
    // intensity 下限を設けて可聴を確保
    const intensity = Math.max(INTENSITY_MIN, Math.min(1.0, rawIntensity))
    const panX = opts?.panX ?? 0
    const serve = opts?.serve ?? false
    const just = opts?.just ?? false
    const mishit = opts?.mishit ?? false

    // ショット種別のパラメータを取得
    const p = HIT_SOUND_PARAMS[shot]

    // ラウンドロビン用の微ピッチ揺らぎ(反復感を消す)
    const pitchJitter = 1.0 + (Math.random() * 2 - 1) * SFX_HIT_PITCH_JITTER

    // --- 音量・余韻 ---
    const baseGain = p.gain * intensity * (serve ? SFX_SERVE_GAIN_MUL : 1.0)
    const effectiveDecay = p.decay * (serve ? SFX_SERVE_DECAY_MUL : 1.0)

    // --- 明るさ(強打ほど明るく鋭く。差し込まれは鈍く) ---
    // ボディ/シマー/クラックの周波数を持ち上げる係数。mishit は芯を外して曇らせる。
    const brighten = (1.0 + intensity * SFX_HIT_BODY_BRIGHTEN) * (mishit ? 0.6 : 1.0)

    // --- ステレオパン(全レイヤを束ねる) ---
    const panner = ctx.createStereoPanner()
    panner.pan.value = Math.max(-1, Math.min(1, panX))
    panner.connect(master)
    // 残響センド(干渉を防ぐため panner からも薄く送る)
    panner.connect(convolver)

    const now = ctx.currentTime

    // =========================================================================
    // レイヤ1: ボディ(pock) — 音程感のある芯。打球のパンチはここが主役。
    // 三角波を高い周波数から bodyHz へ素早く降下させ、"トッ/パコッ" の芯を作る。
    // mishit は降下幅と明るさを抑え、波形も鈍い sine にして「詰まり」を出す。
    // =========================================================================
    const bodyEnd = p.bodyHz * brighten * pitchJitter
    const bodyStart = bodyEnd * p.bodyStartMul
    const bodyOsc = ctx.createOscillator()
    bodyOsc.type = mishit ? 'sine' : 'triangle'
    bodyOsc.frequency.setValueAtTime(bodyStart, now)
    // 12〜18ms で着地周波数まで一気に降下(短いほど "アタッキー")
    bodyOsc.frequency.exponentialRampToValueAtTime(bodyEnd, now + 0.012 + effectiveDecay * 0.12)
    const bodyEnv = ctx.createGain()
    bodyOsc.connect(bodyEnv)
    bodyEnv.connect(panner)
    applyEnvelope(bodyEnv, ctx, 0.7 * baseGain, 0.0008, effectiveDecay)
    bodyOsc.start(now)
    bodyOsc.stop(now + effectiveDecay + 0.02)

    // =========================================================================
    // レイヤ2: クラック(アタック) — ごく短いハイパスノイズの鋭い立ち上がり。
    // 抜けの良い "パッ"。強打ほどカットオフを上げて高域を抜き、クリスプにする。
    // =========================================================================
    const crackNoise = ctx.createBufferSource()
    crackNoise.buffer = noiseBuf
    const crackHp = ctx.createBiquadFilter()
    crackHp.type = 'highpass'
    crackHp.frequency.value = (SFX_HIT_CLICK_HZ + intensity * 1800) * (mishit ? 0.5 : 1.0)
    const crackEnv = ctx.createGain()
    crackNoise.connect(crackHp)
    crackHp.connect(crackEnv)
    crackEnv.connect(panner)
    applyEnvelope(crackEnv, ctx, 0.5 * p.transient * baseGain, 0.0005, 0.004)
    crackNoise.start(now)
    crackNoise.stop(now + 0.006)

    // =========================================================================
    // レイヤ3: シマー — 1.8〜2.8kHz 帯のバンドパスノイズ。高域の煌めき=クリスプさ。
    // 調査で「クリスプさ=高倍音(1800〜2800Hz)」。mishit ではほぼ消す。
    // =========================================================================
    const shimmerAmt = p.shimmer * intensity * (mishit ? 0.2 : 1.0)
    if (shimmerAmt > 0.01) {
      const shimNoise = ctx.createBufferSource()
      shimNoise.buffer = noiseBuf
      const shimBp = ctx.createBiquadFilter()
      shimBp.type = 'bandpass'
      shimBp.frequency.value = p.bodyHz * SFX_HIT_SHIMMER_MUL * brighten * pitchJitter
      shimBp.Q.value = 3.5
      const shimEnv = ctx.createGain()
      shimNoise.connect(shimBp)
      shimBp.connect(shimEnv)
      shimEnv.connect(panner)
      applyEnvelope(shimEnv, ctx, 0.4 * shimmerAmt * baseGain, 0.001, 0.025)
      shimNoise.start(now)
      shimNoise.stop(now + 0.035)
    }

    // =========================================================================
    // レイヤ4: 弦面リング — bodyHz の高Qバンドパスノイズの短い余韻。
    // just で Q 上昇(澄む)・mishit で Q 下降(鈍る)。sweep で擦り/切りを付加。
    // =========================================================================
    let qMul = 1.0
    if (just) qMul *= SFX_JUST_Q_MUL
    if (mishit) qMul *= SFX_MISHIT_Q_MUL
    const ringNoise = ctx.createBufferSource()
    ringNoise.buffer = noiseBuf
    const ringBp = ctx.createBiquadFilter()
    ringBp.type = 'bandpass'
    const ringHz = bodyEnd
    ringBp.frequency.setValueAtTime(ringHz, now)
    if (p.sweep !== 0) {
      ringBp.frequency.exponentialRampToValueAtTime(ringHz * (1.0 + p.sweep * 0.3), now + effectiveDecay * 0.6)
    }
    ringBp.Q.value = p.q * qMul
    const ringEnv = ctx.createGain()
    ringNoise.connect(ringBp)
    ringBp.connect(ringEnv)
    ringEnv.connect(panner)
    applyEnvelope(ringEnv, ctx, 0.22 * baseGain, 0.001, effectiveDecay * 0.9)
    ringNoise.start(now)
    ringNoise.stop(now + effectiveDecay + 0.02)

    // =========================================================================
    // レイヤ5: ブラシ/擦過ノイズ — スピン/スライスの擦り。sweep 方向にスイープ。
    // mishit 時は ×SFX_MISHIT_NOISE_MUL でノイズを増やし「詰まり」を強調。
    // =========================================================================
    const effectiveNoise = mishit ? p.noise * SFX_MISHIT_NOISE_MUL : p.noise
    if (effectiveNoise > 0.01) {
      const brushNoise = ctx.createBufferSource()
      brushNoise.buffer = noiseBuf
      const brushBp = ctx.createBiquadFilter()
      brushBp.type = 'bandpass'
      const brushHz = bodyEnd * 1.6
      brushBp.frequency.setValueAtTime(brushHz, now)
      if (p.sweep !== 0) {
        brushBp.frequency.exponentialRampToValueAtTime(brushHz * (1.0 + p.sweep * 0.5), now + effectiveDecay * 0.8)
      }
      brushBp.Q.value = 1.5
      const brushEnv = ctx.createGain()
      brushNoise.connect(brushBp)
      brushBp.connect(brushEnv)
      brushEnv.connect(panner)
      applyEnvelope(brushEnv, ctx, 0.28 * effectiveNoise * baseGain, 0.002, effectiveDecay * 1.2)
      brushNoise.start(now)
      brushNoise.stop(now + effectiveDecay * 1.5)
    }

    // =========================================================================
    // just のベル倍音 — ボディ1オクターブ上の sine を一瞬重ね、澄んだ「ピン」を足す。
    // =========================================================================
    if (just) {
      const bellOsc = ctx.createOscillator()
      const bellEnv = ctx.createGain()
      bellOsc.type = 'sine'
      bellOsc.frequency.value = bodyEnd * 2.0
      bellOsc.connect(bellEnv)
      bellEnv.connect(panner)
      applyEnvelope(bellEnv, ctx, SFX_JUST_BELL_GAIN * intensity, 0.001, effectiveDecay * 0.6)
      bellOsc.start(now)
      bellOsc.stop(now + effectiveDecay + 0.01)
    }
  }

  // ---------------------------------------------------------------------------
  // 各効果音の実装(打球以外)
  // ---------------------------------------------------------------------------

  /**
   * bounce: 短いローパスノイズによるバウンド音。
   */
  private playBounce(intensity: number): void {
    const ctx = this.ctx!
    const master = this.master!
    const noiseBuf = this.noiseBuf!

    // 低域ノイズバースト
    const noiseSrc = ctx.createBufferSource()
    const noiseFilter = ctx.createBiquadFilter()
    const noiseEnv = ctx.createGain()
    noiseSrc.buffer = noiseBuf
    noiseFilter.type = 'lowpass'
    noiseFilter.frequency.value = 500
    noiseSrc.connect(noiseFilter)
    noiseFilter.connect(noiseEnv)
    noiseEnv.connect(master)
    applyEnvelope(noiseEnv, ctx, 0.28 * intensity, 0.003, 0.06)
    noiseSrc.start(ctx.currentTime)
    noiseSrc.stop(ctx.currentTime + 0.08)

    // ピッチ成分: ごく短いサブベース
    const osc = ctx.createOscillator()
    const oscEnv = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(180, ctx.currentTime)
    osc.frequency.exponentialRampToValueAtTime(60, ctx.currentTime + 0.06)
    osc.connect(oscEnv)
    oscEnv.connect(master)
    applyEnvelope(oscEnv, ctx, 0.25 * intensity, 0.002, 0.055)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.07)
  }

  /**
   * net: 鈍い低音(ネット衝突音)。
   */
  private playNet(intensity: number): void {
    const ctx = this.ctx!
    const master = this.master!
    const noiseBuf = this.noiseBuf!

    // 低域ローパスノイズ(鈍い音)
    const noiseSrc = ctx.createBufferSource()
    const noiseFilter = ctx.createBiquadFilter()
    const noiseEnv = ctx.createGain()
    noiseSrc.buffer = noiseBuf
    noiseFilter.type = 'lowpass'
    noiseFilter.frequency.value = 300
    noiseSrc.connect(noiseFilter)
    noiseFilter.connect(noiseEnv)
    noiseEnv.connect(master)
    applyEnvelope(noiseEnv, ctx, 0.35 * intensity, 0.005, 0.12)
    noiseSrc.start(ctx.currentTime)
    noiseSrc.stop(ctx.currentTime + 0.15)

    // 低音サブベース
    const osc = ctx.createOscillator()
    const oscEnv = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 70
    osc.connect(oscEnv)
    oscEnv.connect(master)
    applyEnvelope(oscEnv, ctx, 0.3 * intensity, 0.005, 0.10)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.14)
  }

  /**
   * point: ポイント獲得時の短い2音ジングル(上昇する2音)。
   */
  private playPoint(intensity: number): void {
    const ctx = this.ctx!
    const master = this.master!

    // 1音目
    const osc1 = ctx.createOscillator()
    const env1 = ctx.createGain()
    osc1.type = 'sine'
    osc1.frequency.value = 660
    osc1.connect(env1)
    env1.connect(master)
    const now = ctx.currentTime
    env1.gain.setValueAtTime(0, now)
    env1.gain.linearRampToValueAtTime(0.4 * intensity, now + 0.01)
    env1.gain.exponentialRampToValueAtTime(0.0001, now + 0.18)
    osc1.start(now)
    osc1.stop(now + 0.20)

    // 2音目(少し高め、少し後から)
    const osc2 = ctx.createOscillator()
    const env2 = ctx.createGain()
    osc2.type = 'sine'
    osc2.frequency.value = 880
    osc2.connect(env2)
    env2.connect(master)
    const t2 = now + 0.15
    env2.gain.setValueAtTime(0, t2)
    env2.gain.linearRampToValueAtTime(0.45 * intensity, t2 + 0.01)
    env2.gain.exponentialRampToValueAtTime(0.0001, t2 + 0.22)
    osc2.start(t2)
    osc2.stop(t2 + 0.25)
  }

  /**
   * applause: 1.2秒程度の歓声風(フィルタ付きノイズ)。
   */
  private playApplause(intensity: number): void {
    const ctx = this.ctx!
    const master = this.master!
    const noiseBuf = this.noiseBuf!
    const duration = 1.2

    // ノイズを繰り返し再生(バッファはループ)
    const noiseSrc = ctx.createBufferSource()
    noiseSrc.buffer = noiseBuf
    noiseSrc.loop = true

    // バンドパスフィルタで歓声帯域を強調
    const bpFilter = ctx.createBiquadFilter()
    bpFilter.type = 'bandpass'
    bpFilter.frequency.value = 1400
    bpFilter.Q.value = 0.5

    // エンベロープ: ゆっくり上がって緩やかに消える
    const envNode = ctx.createGain()
    noiseSrc.connect(bpFilter)
    bpFilter.connect(envNode)
    envNode.connect(master)

    const now = ctx.currentTime
    envNode.gain.setValueAtTime(0, now)
    envNode.gain.linearRampToValueAtTime(0.55 * intensity, now + 0.15)
    envNode.gain.setValueAtTime(0.55 * intensity, now + duration - 0.3)
    envNode.gain.exponentialRampToValueAtTime(0.0001, now + duration)

    noiseSrc.start(now)
    noiseSrc.stop(now + duration + 0.05)

    // 追加: 高域ノイズレイヤーで賑やかさを出す
    const noiseSrc2 = ctx.createBufferSource()
    noiseSrc2.buffer = noiseBuf
    noiseSrc2.loop = true
    const hpFilter = ctx.createBiquadFilter()
    hpFilter.type = 'highpass'
    hpFilter.frequency.value = 2500
    const env2 = ctx.createGain()
    noiseSrc2.connect(hpFilter)
    hpFilter.connect(env2)
    env2.connect(master)
    env2.gain.setValueAtTime(0, now)
    env2.gain.linearRampToValueAtTime(0.15 * intensity, now + 0.2)
    env2.gain.setValueAtTime(0.15 * intensity, now + duration - 0.4)
    env2.gain.exponentialRampToValueAtTime(0.0001, now + duration)
    noiseSrc2.start(now)
    noiseSrc2.stop(now + duration + 0.05)
  }

  /**
   * ui: UIクリック音(短い高音クリック)。
   */
  private playUi(intensity: number): void {
    const ctx = this.ctx!
    const master = this.master!

    const osc = ctx.createOscillator()
    const envNode = ctx.createGain()
    osc.type = 'square'
    osc.frequency.value = 1200
    osc.connect(envNode)
    envNode.connect(master)
    const now = ctx.currentTime
    envNode.gain.setValueAtTime(0, now)
    envNode.gain.linearRampToValueAtTime(0.18 * intensity, now + 0.005)
    envNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.045)
    osc.start(now)
    osc.stop(now + 0.05)
  }

  // ---------------------------------------------------------------------------
  // ノイズバッファ生成
  // ---------------------------------------------------------------------------

  /**
   * ホワイトノイズバッファを1回生成して返す。
   * 生成後は this.noiseBuf に保持して使い回す。
   */
  private createNoiseBuf(ctx: AudioContext): AudioBuffer {
    const buf = ctx.createBuffer(1, NOISE_BUF_SAMPLES, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < NOISE_BUF_SAMPLES; i++) {
      // -1..1 の一様乱数
      data[i] = Math.random() * 2 - 1
    }
    return buf
  }

  // ---------------------------------------------------------------------------
  // 残響 IR 生成
  // ---------------------------------------------------------------------------

  /**
   * 手続き生成の短いインパルス応答(指数減衰ノイズ)を AudioBuffer として生成する。
   * SFX_REVERB_SECONDS 秒、ステレオ2チャンネル。ConvolverNode に1回だけセットして使い回す。
   * 外部 IR ファイルは使わない。
   */
  private createReverbIR(ctx: AudioContext): AudioBuffer {
    const sampleRate = ctx.sampleRate
    const length = Math.floor(SFX_REVERB_SECONDS * sampleRate)
    const ir = ctx.createBuffer(2, length, sampleRate)
    for (let ch = 0; ch < 2; ch++) {
      const data = ir.getChannelData(ch)
      for (let i = 0; i < length; i++) {
        // 指数減衰ノイズ: e^(-i/tau) * rand。tau = length/4 で十分短い残響に
        const t = i / sampleRate
        const decay = Math.exp(-t / (SFX_REVERB_SECONDS * 0.25))
        data[i] = (Math.random() * 2 - 1) * decay
      }
    }
    return ir
  }
}
