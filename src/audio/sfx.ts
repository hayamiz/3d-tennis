// =============================================================================
// 効果音モジュール — WebAudio API による合成音
// 外部アセット不使用。OscillatorNode + ノイズバッファ + BiquadFilter + ConvolverNode で生成。
// 打球音は playHit(shot, opts) に集約。bounce/net/point/applause/ui は play(name) で扱う。
// =============================================================================
import type { SfxName, ShotType } from '../types'
import {
  HIT_SOUND_PARAMS,
  SFX_HIT_BRIGHTNESS_HZ,
  SFX_HIT_CLICK_HZ,
  SFX_HIT_PITCH_JITTER,
  SFX_JUST_BELL_GAIN,
  SFX_JUST_Q_MUL,
  SFX_MISHIT_NOISE_MUL,
  SFX_MISHIT_Q_MUL,
  SFX_REVERB_SECONDS,
  SFX_REVERB_WET,
  SFX_SERVE_DECAY_MUL,
  SFX_SERVE_GAIN_MUL,
} from '../constants'

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
    }

    // iOS Safari 等では suspended 状態になることがあるため resume
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume()
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
   * 打球音を再生する。ショット種別ごとにパラメータを切り替えてリアルタイム合成する。
   *
   * 3レイヤ合成: クリック(鋭いアタック) + 共鳴ボディ("パコッ") + ブラシノイズ(擦過)。
   * 全レイヤを StereoPannerNode(panX) → master に通し、残響センド(ConvolverNode)にも薄く送る。
   *
   * @param shot  - ショット種別
   * @param opts  - 合成オプション
   *   - intensity 0..1(デフォルト 1.0): 球威/チャージ由来。強いほど明るく鋭く・大きい。
   *   - panX -1..1(デフォルト 0): ステレオ定位。打点の x 座標を渡す。
   *   - serve true: フラットを増強(SFX_SERVE_GAIN_MUL/DECAY_MUL 適用)。
   *   - just true: 最もクリアな共鳴(Q × SFX_JUST_Q_MUL) + ごく短いベル倍音。
   *   - mishit true: 共鳴を鈍く(Q × SFX_MISHIT_Q_MUL)・ノイズ多め・詰まった「コツッ」。
   */
  playHit(
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

    // --- Q 係数の決定 ---
    let qMul = 1.0
    if (just) qMul *= SFX_JUST_Q_MUL
    if (mishit) qMul *= SFX_MISHIT_Q_MUL
    const effectiveQ = p.q * qMul

    // --- 音量計算 ---
    const serveMul = serve ? SFX_SERVE_GAIN_MUL : 1.0
    const baseGain = p.gain * intensity * serveMul

    // --- 余韻の減衰時間 ---
    const decayMul = serve ? SFX_SERVE_DECAY_MUL : 1.0
    const effectiveDecay = p.decay * decayMul

    // --- 共鳴中心周波数(intensity と微ピッチ揺らぎを加味) ---
    const resonanceHz = (p.resonanceHz + intensity * SFX_HIT_BRIGHTNESS_HZ) * pitchJitter

    // --- ステレオパン(全レイヤを束ねる) ---
    const panner = ctx.createStereoPanner()
    panner.pan.value = Math.max(-1, Math.min(1, panX))
    panner.connect(master)
    // 残響センド(干渉を防ぐため panner からも薄く送る)
    panner.connect(convolver)

    const now = ctx.currentTime

    // =========================================================================
    // レイヤ1: クリック(アタック)
    // ごく短いノイズ(~2ms)をハイパスで通した鋭い立ち上がり。クリスプ感の核。
    // =========================================================================
    const clickDuration = 0.004 // ~4ms(アタックの核)
    const clickNoise = ctx.createBufferSource()
    clickNoise.buffer = noiseBuf
    // intensity が高いほどハイパスのカットオフを上げて高域を抜く
    const clickHp = ctx.createBiquadFilter()
    clickHp.type = 'highpass'
    clickHp.frequency.value = 4000 + intensity * SFX_HIT_CLICK_HZ
    const clickEnv = ctx.createGain()
    const clickPeak = 0.35 * p.transient * baseGain
    clickNoise.connect(clickHp)
    clickHp.connect(clickEnv)
    clickEnv.connect(panner)
    applyEnvelope(clickEnv, ctx, clickPeak, 0.001, 0.003)
    clickNoise.start(now)
    clickNoise.stop(now + clickDuration)

    // =========================================================================
    // レイヤ2: 共鳴ボディ("パコッ")
    // ノイズを高Qバンドパスで鳴らす。just で Q 上昇・mishit で Q 下降。
    // sweep≠0 のとき中心周波数を短時間でスイープして擦り/切り感を出す。
    // =========================================================================
    const resoNoise = ctx.createBufferSource()
    resoNoise.buffer = noiseBuf
    const resoBp = ctx.createBiquadFilter()
    resoBp.type = 'bandpass'
    resoBp.frequency.setValueAtTime(resonanceHz, now)
    // sweep: +1=上昇(topspin 擦り上げ), -1=下降(slice 切り), 0=なし
    if (p.sweep !== 0) {
      const sweepTarget = resonanceHz * (1.0 + p.sweep * 0.35)
      const sweepTime = effectiveDecay * 0.6
      resoBp.frequency.exponentialRampToValueAtTime(sweepTarget, now + sweepTime)
    }
    resoBp.Q.value = effectiveQ
    const resoEnv = ctx.createGain()
    const resoPeak = 0.55 * baseGain
    resoNoise.connect(resoBp)
    resoBp.connect(resoEnv)
    resoEnv.connect(panner)
    // 攻撃時間 ~1ms、減衰は effectiveDecay
    applyEnvelope(resoEnv, ctx, resoPeak, 0.001, effectiveDecay)
    resoNoise.start(now)
    resoNoise.stop(now + effectiveDecay + 0.02)

    // 共鳴の1オクターブ下を薄く重ねて厚みを足す(低域は控えめにして濁りを避ける)
    const resoLowNoise = ctx.createBufferSource()
    resoLowNoise.buffer = noiseBuf
    const resoLowBp = ctx.createBiquadFilter()
    resoLowBp.type = 'bandpass'
    resoLowBp.frequency.value = resonanceHz * 0.5
    resoLowBp.Q.value = effectiveQ * 0.5
    const resoLowEnv = ctx.createGain()
    const resoLowPeak = 0.12 * baseGain
    resoLowNoise.connect(resoLowBp)
    resoLowBp.connect(resoLowEnv)
    resoLowEnv.connect(panner)
    applyEnvelope(resoLowEnv, ctx, resoLowPeak, 0.001, effectiveDecay * 0.7)
    resoLowNoise.start(now)
    resoLowNoise.stop(now + effectiveDecay + 0.01)

    // =========================================================================
    // レイヤ3: ブラシ/擦過ノイズ
    // p.noise(mishit 時は ×SFX_MISHIT_NOISE_MUL)に比例した帯域ノイズ。
    // sweep 方向にスイープさせて topspin の擦り上げ/slice の切りを表現。
    // =========================================================================
    const effectiveNoise = mishit ? p.noise * SFX_MISHIT_NOISE_MUL : p.noise
    if (effectiveNoise > 0.01) {
      const brushNoise = ctx.createBufferSource()
      brushNoise.buffer = noiseBuf
      const brushBp = ctx.createBiquadFilter()
      brushBp.type = 'bandpass'
      // ブラシは共鳴より少し上の帯域(1.3倍付近)
      const brushHz = resonanceHz * 1.3
      brushBp.frequency.setValueAtTime(brushHz, now)
      if (p.sweep !== 0) {
        const brushTarget = brushHz * (1.0 + p.sweep * 0.5)
        const brushSweepTime = effectiveDecay * 0.8
        brushBp.frequency.exponentialRampToValueAtTime(brushTarget, now + brushSweepTime)
      }
      brushBp.Q.value = 1.5
      const brushEnv = ctx.createGain()
      const brushPeak = 0.3 * effectiveNoise * baseGain
      brushNoise.connect(brushBp)
      brushBp.connect(brushEnv)
      brushEnv.connect(panner)
      applyEnvelope(brushEnv, ctx, brushPeak, 0.002, effectiveDecay * 1.2)
      brushNoise.start(now)
      brushNoise.stop(now + effectiveDecay * 1.5)
    }

    // =========================================================================
    // just のベル倍音
    // 共鳴より少し上の周波数の sine を一瞬重ね、澄んだ「ピン」を足す。
    // =========================================================================
    if (just) {
      const bellOsc = ctx.createOscillator()
      const bellEnv = ctx.createGain()
      bellOsc.type = 'sine'
      // 共鳴より短3度上(≈1.19倍)のベル音
      bellOsc.frequency.value = resonanceHz * 1.19
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
