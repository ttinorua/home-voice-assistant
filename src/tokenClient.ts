import { config } from './config';

export class TokenError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'TokenError';
  }
}

/** Asks the token endpoint for a short-lived session token. Status 0 means the network failed. */
export async function fetchToken(
  passcode: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<string> {
  let res: Response;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    res = await fetchImpl(config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passcode }),
      signal: abort.signal,
    });
  } catch {
    throw new TokenError(0, 'network error or timeout');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new TokenError(res.status, `token request failed (${res.status})`);
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new TokenError(res.status, 'no token in response');
  return data.token;
}
