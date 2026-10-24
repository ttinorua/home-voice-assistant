// @vitest-environment jsdom
import { BrowserMicSource, createWorkletPipeline } from '../../src/audio/micSource';

function fakeTrack() {
  const handlers: Record<string, (() => void)[]> = {};
  return {
    stopped: false,
    stop() { this.stopped = true; },
    addEventListener(type: string, cb: () => void) { (handlers[type] ??= []).push(cb); },
    fire(type: string) { (handlers[type] ?? []).forEach((cb) => cb()); },
  };
}

function fakeStream() {
  const tracks = [fakeTrack(), fakeTrack()];
  return { stream: { getTracks: () => tracks } as unknown as MediaStream, tracks };
}

test('BrowserMicSource requests audio with echoCancellation, noiseSuppression and autoGainControl all true', async () => {
  const { stream } = fakeStream();
  let asked: MediaStreamConstraints | undefined;
  const mic = new BrowserMicSource({
    openStream: async (c) => { asked = c; return stream; },
    createPipeline: async () => ({ stop() {} }),
  });
  await mic.start(() => {});
  expect(asked).toEqual({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
});

test('stop stops every track of the stream and the pipeline', async () => {
  const { stream, tracks } = fakeStream();
  let pipelineStopped = false;
  const mic = new BrowserMicSource({
    openStream: async () => stream,
    createPipeline: async () => ({ stop() { pipelineStopped = true; } }),
  });
  await mic.start(() => {});
  mic.stop();
  expect(tracks.every((t) => t.stopped)).toBe(true);
  expect(pipelineStopped).toBe(true);
});

test('start rejects with NotAllowedError when getUserMedia is denied and leaves no tracks running', async () => {
  const denied = new Error('denied');
  denied.name = 'NotAllowedError';
  const mic = new BrowserMicSource({
    openStream: async () => { throw denied; },
    createPipeline: async () => ({ stop() {} }),
  });
  await expect(mic.start(() => {})).rejects.toMatchObject({ name: 'NotAllowedError' });
});

test('if building the audio pipeline fails after the mic opened, the tracks are stopped', async () => {
  const { stream, tracks } = fakeStream();
  const mic = new BrowserMicSource({
    openStream: async () => stream,
    createPipeline: async () => { throw new Error('worklet failed'); },
  });
  await expect(mic.start(() => {})).rejects.toThrow('worklet failed');
  expect(tracks.every((t) => t.stopped)).toBe(true);
});

test('chunks from the pipeline reach the onChunk callback', async () => {
  const { stream } = fakeStream();
  let push!: (c: Int16Array) => void;
  const got: number[][] = [];
  const mic = new BrowserMicSource({
    openStream: async () => stream,
    createPipeline: async (_s, onChunk) => { push = onChunk; return { stop() {} }; },
  });
  await mic.start((c) => got.push(Array.from(c)));
  push(new Int16Array([9, 8]));
  expect(got).toEqual([[9, 8]]);
});

function fakeAudioEnv(opts: { failLoad?: boolean } = {}) {
  const state = { resumed: 0, closed: 0, nodeOptions: [] as any[], node: null as any };
  const ctx = {
    sampleRate: 48000,
    audioWorklet: { addModule: async () => { if (opts.failLoad) throw new Error('load failed'); } },
    resume: async () => { state.resumed++; },
    close: async () => { state.closed++; },
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
  };
  const env = {
    createContext: () => ctx as any,
    createNode: (_c: any, options: any) => {
      state.nodeOptions.push(options);
      state.node = { port: { onmessage: null as any }, connect() {}, disconnect() {} };
      return state.node;
    },
  };
  return { env, state };
}

test('worklet pipeline resumes the audio context and creates the capture node with no outputs', async () => {
  const { env, state } = fakeAudioEnv();
  await createWorkletPipeline({} as MediaStream, () => {}, env);
  expect(state.resumed).toBe(1);
  expect(state.nodeOptions[0]).toMatchObject({ numberOfOutputs: 0 });
});

test('worklet pipeline closes the audio context when loading the worklet fails', async () => {
  const { env, state } = fakeAudioEnv({ failLoad: true });
  await expect(createWorkletPipeline({} as MediaStream, () => {}, env)).rejects.toThrow('load failed');
  expect(state.closed).toBe(1);
});

test('worklet pipeline turns 48 kHz mic blocks into 16 kHz PCM16 chunks', async () => {
  const { env, state } = fakeAudioEnv();
  const got: Int16Array[] = [];
  await createWorkletPipeline({} as MediaStream, (c) => got.push(c), env);
  state.node.port.onmessage({ data: new Float32Array(480).fill(0.5) });
  expect(got[0]).toHaveLength(160);
  expect(Math.abs(got[0][0] - 16384)).toBeLessThanOrEqual(1);
});

test('stopping the worklet pipeline closes the audio context', async () => {
  const { env, state } = fakeAudioEnv();
  const pipeline = await createWorkletPipeline({} as MediaStream, () => {}, env);
  pipeline.stop();
  expect(state.closed).toBe(1);
});

test('when a mic track ends on its own (for example Bluetooth headphones disconnect), onEnded fires once', async () => {
  const { stream, tracks } = fakeStream();
  const mic = new BrowserMicSource({ openStream: async () => stream, createPipeline: async () => ({ stop() {} }) });
  let ended = 0;
  mic.onEnded(() => ended++);
  await mic.start(() => {});
  tracks[0].fire('ended');
  tracks[1].fire('ended');
  expect(ended).toBe(1);
});

test('stopping the mic ourselves does not count as the mic ending on its own', async () => {
  const { stream, tracks } = fakeStream();
  const mic = new BrowserMicSource({ openStream: async () => stream, createPipeline: async () => ({ stop() {} }) });
  let ended = 0;
  mic.onEnded(() => ended++);
  await mic.start(() => {});
  mic.stop();
  tracks[0].fire('ended');
  expect(ended).toBe(0);
});
