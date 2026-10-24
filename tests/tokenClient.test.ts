import { fetchToken, TokenError } from '../src/tokenClient';

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    (fakeFetch as any).lastInit = init;
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

test('fetchToken posts the passcode as JSON and returns the token', async () => {
  const f = fakeFetch(200, { token: 'abc' });
  expect(await fetchToken('open-sesame', f)).toBe('abc');
  const init = (fakeFetch as any).lastInit as RequestInit;
  expect(init.method).toBe('POST');
  expect(JSON.parse(init.body as string)).toEqual({ passcode: 'open-sesame' });
});

test('fetchToken throws TokenError with status 401 on a 401', async () => {
  const err = await fetchToken('x', fakeFetch(401, { error: 'unauthorized' })).catch((e) => e);
  expect(err).toBeInstanceOf(TokenError);
  expect(err.status).toBe(401);
});

test('fetchToken throws TokenError with status 0 on network failure', async () => {
  const failing = (async () => { throw new TypeError('network down'); }) as unknown as typeof fetch;
  const err = await fetchToken('x', failing).catch((e) => e);
  expect(err).toBeInstanceOf(TokenError);
  expect(err.status).toBe(0);
});

test('fetchToken gives up with TokenError status 0 when the server does not answer within the timeout', async () => {
  vi.useFakeTimers();
  try {
    const hanging = ((_u: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    const pending = fetchToken('x', hanging, 10_000).catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    const err = await pending;
    expect(err).toBeInstanceOf(TokenError);
    expect(err.status).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
