import { pcm16ToFloat } from './pcm';

export interface AudioSink {
  now(): number;
  schedule(samples: Float32Array, startAt: number, sampleRate: number): { stop(): void };
}

/** Plays reply audio chunks back-to-back, and can cut everything off instantly. */
export class PlaybackQueue {
  private nextStart = 0;
  private handles: { stop(): void }[] = [];
  private closed = false;

  constructor(private sink: AudioSink, private sampleRate: number) {}

  enqueue(chunk: Int16Array): void {
    if (this.closed || chunk.length === 0) return;
    const start = Math.max(this.sink.now(), this.nextStart);
    this.handles.push(this.sink.schedule(pcm16ToFloat(chunk), start, this.sampleRate));
    this.nextStart = start + chunk.length / this.sampleRate;
  }

  flush(): void {
    for (const h of this.handles) h.stop();
    this.handles = [];
    this.nextStart = 0;
  }

  close(): void {
    this.flush();
    this.closed = true;
  }

  isPlaying(): boolean {
    return !this.closed && this.sink.now() < this.nextStart;
  }
}

/** Real browser output via the Web Audio API. Exercised in the on-phone test (Task 9). */
export class WebAudioSink implements AudioSink {
  private ctx: AudioContext;

  constructor(ctx?: AudioContext) {
    this.ctx = ctx ?? new AudioContext();
  }

  now(): number {
    return this.ctx.currentTime;
  }

  async resume(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  schedule(samples: Float32Array, startAt: number, sampleRate: number): { stop(): void } {
    const buffer = this.ctx.createBuffer(1, samples.length, sampleRate);
    buffer.getChannelData(0).set(samples);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);
    src.start(startAt);
    return {
      stop: () => {
        try { src.stop(); } catch { /* already finished */ }
        src.disconnect();
      },
    };
  }
}
