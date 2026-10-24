import { ScreenAwake, type WakeLockEnv } from '../src/screenAwake';

function fakeEnv(opts: { supported?: boolean; rejectWith?: Error } = {}) {
  const state = { requests: 0, released: 0, visible: true, visibleCb: () => {}, dropCbs: [] as (() => void)[] };
  const env: WakeLockEnv = {
    request: opts.supported === false ? undefined : async () => {
      state.requests++;
      if (opts.rejectWith) throw opts.rejectWith;
      const sentinel = {
        release: async () => { state.released++; },
        onRelease: (cb: () => void) => { state.dropCbs.push(cb); },
      };
      return sentinel;
    },
    isVisible: () => state.visible,
    onVisible: (cb) => { state.visibleCb = cb; },
  };
  return { env, state };
}

test('hold requests the screen lock once, even when called twice', async () => {
  const { env, state } = fakeEnv();
  const awake = new ScreenAwake(env);
  await awake.hold();
  await awake.hold();
  expect(state.requests).toBe(1);
});

test('release gives the screen lock back', async () => {
  const { env, state } = fakeEnv();
  const awake = new ScreenAwake(env);
  await awake.hold();
  await awake.release();
  expect(state.released).toBe(1);
});

test('when the browser drops the lock (page was hidden) and the page returns, it asks again', async () => {
  const { env, state } = fakeEnv();
  const awake = new ScreenAwake(env);
  await awake.hold();
  state.dropCbs.forEach((cb) => cb()); // browser released it on its own
  await state.visibleCb();
  expect(state.requests).toBe(2);
});

test('after release, the page becoming visible does not ask again', async () => {
  const { env, state } = fakeEnv();
  const awake = new ScreenAwake(env);
  await awake.hold();
  await awake.release();
  await state.visibleCb();
  expect(state.requests).toBe(1);
});

test('a browser without screen lock support does not crash', async () => {
  const { env } = fakeEnv({ supported: false });
  const awake = new ScreenAwake(env);
  await expect(awake.hold()).resolves.toBeUndefined();
  await expect(awake.release()).resolves.toBeUndefined();
});

test('a refused request (for example battery saver) does not crash', async () => {
  const { env } = fakeEnv({ rejectWith: new Error('NotAllowedError') });
  const awake = new ScreenAwake(env);
  await expect(awake.hold()).resolves.toBeUndefined();
});

test('does not ask while the page is hidden, but asks when it becomes visible', async () => {
  const { env, state } = fakeEnv();
  state.visible = false;
  const awake = new ScreenAwake(env);
  await awake.hold();
  expect(state.requests).toBe(0);
  state.visible = true;
  await state.visibleCb();
  expect(state.requests).toBe(1);
});
