import type { MicSource } from '../session/sessionController';
import { downsample, floatToPcm16 } from './pcm';

const TARGET_RATE = 16000;

export interface Pipeline {
  stop(): void;
}

export interface MicDeps {
  openStream(c: MediaStreamConstraints): Promise<MediaStream>;
  createPipeline(stream: MediaStream, onChunk: (c: Int16Array) => void): Promise<Pipeline>;
}

// The slice of the browser's audio objects that the pipeline uses; tests pass fakes of these.
export interface AudioEnv {
  createContext(): any;
  createNode(ctx: any, options: { numberOfOutputs: number }): any;
}

const browserEnv: AudioEnv = {
  createContext: () => new AudioContext(),
  createNode: (ctx, options) => new AudioWorkletNode(ctx, 'capture-processor', options),
};

/** Real browser pipeline: mic → AudioWorklet → 16 kHz PCM16 chunks. Final check happens on the phone (Task 9). */
export async function createWorkletPipeline(
  stream: MediaStream,
  onChunk: (c: Int16Array) => void,
  env: AudioEnv = browserEnv,
): Promise<Pipeline> {
  const ctx = env.createContext();
  try {
    await ctx.resume(); // some phones start the context suspended, which would silence the mic
    await ctx.audioWorklet.addModule('/capture-processor.js');
    const source = ctx.createMediaStreamSource(stream);
    // No outputs: the mic is only analysed, never played back.
    const node = env.createNode(ctx, { numberOfOutputs: 0 });
    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      onChunk(floatToPcm16(downsample(e.data, ctx.sampleRate, TARGET_RATE)));
    };
    source.connect(node);
    return {
      stop() {
        node.port.onmessage = null;
        source.disconnect();
        node.disconnect();
        void ctx.close();
      },
    };
  } catch (e) {
    void ctx.close(); // do not leak an audio context when setup fails
    throw e;
  }
}

export class BrowserMicSource implements MicSource {
  private stream: MediaStream | null = null;
  private pipeline: Pipeline | null = null;
  private endedCb: () => void = () => {};
  private endedFired = false;

  constructor(
    private deps: MicDeps = {
      openStream: (c) => navigator.mediaDevices.getUserMedia(c),
      createPipeline: createWorkletPipeline,
    },
  ) {}

  /** Called once if the microphone stops by itself, for example when Bluetooth headphones disconnect. */
  onEnded(cb: () => void): void {
    this.endedCb = cb;
  }

  async start(onChunk: (c: Int16Array) => void): Promise<void> {
    const stream = await this.deps.openStream({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.stream = stream;
    this.endedFired = false;
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => {
        // Ignore ends we caused ourselves (stop() clears this.stream first).
        if (this.stream !== stream || this.endedFired) return;
        this.endedFired = true;
        this.endedCb();
      });
    }
    try {
      this.pipeline = await this.deps.createPipeline(stream, onChunk);
    } catch (e) {
      this.stop(); // never leave the mic open if the audio pipeline could not start
      throw e;
    }
  }

  stop(): void {
    const stream = this.stream;
    this.stream = null;
    this.pipeline?.stop();
    this.pipeline = null;
    stream?.getTracks().forEach((t) => t.stop());
  }
}
