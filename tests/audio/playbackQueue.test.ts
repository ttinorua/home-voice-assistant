import { PlaybackQueue, type AudioSink } from '../../src/audio/playbackQueue';

class FakeSink implements AudioSink {
  time = 1;
  scheduled: { samples: Float32Array; startAt: number; sampleRate: number; stopped: boolean }[] = [];
  now() { return this.time; }
  schedule(samples: Float32Array, startAt: number, sampleRate: number) {
    const item = { samples, startAt, sampleRate, stopped: false };
    this.scheduled.push(item);
    return { stop: () => { item.stopped = true; } };
  }
}

const RATE = 24000;
const chunk = () => new Int16Array(2400); // 0.1 s

test('second chunk starts exactly when the first ends', () => {
  const sink = new FakeSink();
  const q = new PlaybackQueue(sink, RATE);
  q.enqueue(chunk());
  q.enqueue(chunk());
  expect(sink.scheduled[0].startAt).toBeCloseTo(1.0, 6);
  expect(sink.scheduled[1].startAt).toBeCloseTo(1.1, 6);
});

test('flush stops every scheduled source', () => {
  const sink = new FakeSink();
  const q = new PlaybackQueue(sink, RATE);
  q.enqueue(chunk());
  q.enqueue(chunk());
  q.flush();
  expect(sink.scheduled.every((s) => s.stopped)).toBe(true);
});

test('chunk enqueued after flush starts at sink.now(), not after the old tail', () => {
  const sink = new FakeSink();
  const q = new PlaybackQueue(sink, RATE);
  q.enqueue(chunk());
  q.enqueue(chunk());
  q.flush();
  sink.time = 1.02;
  q.enqueue(chunk());
  expect(sink.scheduled[2].startAt).toBeCloseTo(1.02, 6);
});

test('enqueue after close schedules nothing', () => {
  const sink = new FakeSink();
  const q = new PlaybackQueue(sink, RATE);
  q.close();
  q.enqueue(chunk());
  expect(sink.scheduled).toHaveLength(0);
});

test('isPlaying is false after the last chunk end time passes', () => {
  const sink = new FakeSink();
  const q = new PlaybackQueue(sink, RATE);
  q.enqueue(chunk());
  expect(q.isPlaying()).toBe(true);
  sink.time = 1.11;
  expect(q.isPlaying()).toBe(false);
});
