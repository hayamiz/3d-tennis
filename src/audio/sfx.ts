// =============================================================================
// 効果音モジュール — WebAudio API による合成音
// 外部アセット不使用。OscillatorNode + ノイズバッファ + BiquadFilter で生成。
// =============================================================================
import type { SfxName } from '../types'

// ---------------------------------------------------------------------------
// 内部定数
// ---------------------------------------------------------------------------

/** マスターゲイン(同時発音での音割れ防止のため控えめな値) */
const MASTER_GAIN = 0.5

/** ホワイトノイズバッファのサンプル数(~0.5秒分、44100Hz 想定) */
const NOISE_BUF_SAMPLES = 22050

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
 * resume() 前に play() が呼ばれても例外は出さず無視する。
 */
export class Sfx {
  /** AudioContext。resume() 前は null */
  private ctx: AudioContext | null = null
  /** マスターゲインノード */
  private master: GainNode | null = null
  /** 使い回すホワイトノイズバッファ */
  private noiseBuf: AudioBuffer | null = null

  // ---------------------------------------------------------------------------
  // 公開 API
  // ---------------------------------------------------------------------------

  /**
   * 初回ユーザー操作時に呼ぶ。
   * AudioContext を生成(または resume)し、ノイズバッファを初期化する。
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
    }

    // iOS Safari 等では suspended 状態になることがあるため resume
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume()
    }
  }

  /**
   * 効果音を再生する。
   * @param name  - 再生する効果音の識別子
   * @param opts  - intensity 0..1(デフォルト 1.0)。音量・ピッチの調整に使う。
   */
  play(name: SfxName, opts?: { intensity?: number }): void {
    // resume() 前または AudioContext 未準備なら無視
    if (!this.ctx || !this.master || !this.noiseBuf) return
    if (this.ctx.state === 'suspended') return

    const intensity = opts?.intensity ?? 1.0

    switch (name) {
      case 'hit_flat':
        this.playHitFlat(intensity)
        break
      case 'hit_spin':
        this.playHitSpin(intensity)
        break
      case 'hit_slice':
        this.playHitSlice(intensity)
        break
      case 'bounce':
        this.playBounce(intensity)
        break
      case 'net':
        this.playNet(intensity)
        break
      case 'serve':
        this.playServe(intensity)
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

  // ---------------------------------------------------------------------------
  // 各効果音の実装
  // ---------------------------------------------------------------------------

  /**
   * hit_flat: 短いノイズバースト + 低域パンチ。
   * intensity で音量とピッチを調整。
   */
  private playHitFlat(intensity: number): void {
    const ctx = this.ctx!
    const master = this.master!
    const noiseBuf = this.noiseBuf!

    // 低域パンチ: 短い Oscillator のサブベース
    const osc = ctx.createOscillator()
    const oscEnv = ctx.createGain()
    const filter = ctx.createBiquadFilter()
    osc.type = 'sine'
    // intensity が高いほど低めのピッチ(より重い打球感)
    osc.frequency.value = 100 + intensity * 60
    filter.type = 'lowpass'
    filter.frequency.value = 300
    osc.connect(filter)
    filter.connect(oscEnv)
    oscEnv.connect(master)
    applyEnvelope(oscEnv, ctx, 0.45 * intensity, 0.003, 0.08)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.12)

    // ノイズバースト: 帯域制限した短いホワイトノイズ
    const noiseSrc = ctx.createBufferSource()
    const noiseFilter = ctx.createBiquadFilter()
    const noiseEnv = ctx.createGain()
    noiseSrc.buffer = noiseBuf
    noiseFilter.type = 'bandpass'
    noiseFilter.frequency.value = 1200
    noiseFilter.Q.value = 0.8
    noiseSrc.connect(noiseFilter)
    noiseFilter.connect(noiseEnv)
    noiseEnv.connect(master)
    applyEnvelope(noiseEnv, ctx, 0.3 * intensity, 0.002, 0.05)
    noiseSrc.start(ctx.currentTime)
    noiseSrc.stop(ctx.currentTime + 0.08)
  }

  /**
   * hit_spin: やや柔らかいヒット音。低域を落として丸みを出す。
   */
  private playHitSpin(intensity: number): void {
    const ctx = this.ctx!
    const master = this.master!
    const noiseBuf = this.noiseBuf!

    // ベース: 中低域オシレータ
    const osc = ctx.createOscillator()
    const oscEnv = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 140 + intensity * 40
    osc.connect(oscEnv)
    oscEnv.connect(master)
    applyEnvelope(oscEnv, ctx, 0.35 * intensity, 0.004, 0.10)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.14)

    // ノイズ: ローパスフィルタで柔らかく
    const noiseSrc = ctx.createBufferSource()
    const noiseFilter = ctx.createBiquadFilter()
    const noiseEnv = ctx.createGain()
    noiseSrc.buffer = noiseBuf
    noiseFilter.type = 'lowpass'
    noiseFilter.frequency.value = 1800
    noiseSrc.connect(noiseFilter)
    noiseFilter.connect(noiseEnv)
    noiseEnv.connect(master)
    applyEnvelope(noiseEnv, ctx, 0.22 * intensity, 0.003, 0.07)
    noiseSrc.start(ctx.currentTime)
    noiseSrc.stop(ctx.currentTime + 0.10)
  }

  /**
   * hit_slice: 高域寄りで薄いヒット音。
   */
  private playHitSlice(intensity: number): void {
    const ctx = this.ctx!
    const master = this.master!
    const noiseBuf = this.noiseBuf!

    // 高域ノイズ: ハイパスフィルタで薄く
    const noiseSrc = ctx.createBufferSource()
    const noiseFilter = ctx.createBiquadFilter()
    const noiseEnv = ctx.createGain()
    noiseSrc.buffer = noiseBuf
    noiseFilter.type = 'highpass'
    noiseFilter.frequency.value = 3000
    noiseSrc.connect(noiseFilter)
    noiseFilter.connect(noiseEnv)
    noiseEnv.connect(master)
    applyEnvelope(noiseEnv, ctx, 0.20 * intensity, 0.002, 0.05)
    noiseSrc.start(ctx.currentTime)
    noiseSrc.stop(ctx.currentTime + 0.07)

    // 中域の薄いオシレータ
    const osc = ctx.createOscillator()
    const oscFilter = ctx.createBiquadFilter()
    const oscEnv = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.value = 500 + intensity * 200
    oscFilter.type = 'bandpass'
    oscFilter.frequency.value = 600
    oscFilter.Q.value = 1.2
    osc.connect(oscFilter)
    oscFilter.connect(oscEnv)
    oscEnv.connect(master)
    applyEnvelope(oscEnv, ctx, 0.15 * intensity, 0.002, 0.06)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.09)
  }

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
   * serve: 強めのヒット音(サーブ専用)。
   */
  private playServe(intensity: number): void {
    const ctx = this.ctx!
    const master = this.master!
    const noiseBuf = this.noiseBuf!

    // 強い低域パンチ
    const osc = ctx.createOscillator()
    const oscEnv = ctx.createGain()
    const filter = ctx.createBiquadFilter()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(90 + intensity * 50, ctx.currentTime)
    osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.12)
    filter.type = 'lowpass'
    filter.frequency.value = 400
    osc.connect(filter)
    filter.connect(oscEnv)
    oscEnv.connect(master)
    applyEnvelope(oscEnv, ctx, 0.55 * intensity, 0.003, 0.10)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.14)

    // 広帯域ノイズバースト
    const noiseSrc = ctx.createBufferSource()
    const noiseFilter = ctx.createBiquadFilter()
    const noiseEnv = ctx.createGain()
    noiseSrc.buffer = noiseBuf
    noiseFilter.type = 'bandpass'
    noiseFilter.frequency.value = 2000
    noiseFilter.Q.value = 0.6
    noiseSrc.connect(noiseFilter)
    noiseFilter.connect(noiseEnv)
    noiseEnv.connect(master)
    applyEnvelope(noiseEnv, ctx, 0.35 * intensity, 0.002, 0.07)
    noiseSrc.start(ctx.currentTime)
    noiseSrc.stop(ctx.currentTime + 0.10)
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
}
