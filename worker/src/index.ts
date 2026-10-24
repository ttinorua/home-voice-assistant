// Token endpoint. Holds the Google API key as a secret and hands the browser a
// short-lived session token after a passcode check. The key never leaves this file.
//
// Provider facts are recorded in the PROVIDER NOTES block above createGeminiMint below.

export interface Env {
  GEMINI_API_KEY: string;
  PASSCODE: string;
  ALLOWED_ORIGIN: string;
}

export interface TokenDeps {
  mint(): Promise<string>;
  now(): number;
}

const MAX_BODY_CHARS = 1024;
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

// Best-effort, per-instance rate limiting. A busy edge may run several instances,
// so this slows abuse down; it is not a hard guarantee.
const hits = new Map<string, number[]>();

export function resetRateLimits(): void {
  hits.clear();
}

function rateLimited(ip: string, nowMs: number): boolean {
  const recent = (hits.get(ip) ?? []).filter((t) => nowMs - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(nowMs);
  hits.set(ip, recent);
  return false;
}

async function sha256(text: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(text);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

// Compare digests (always the same length) without stopping at the first difference.
async function passcodeMatches(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function corsHeaders(env: Env): Record<string, string> {
  return {
    'access-control-allow-origin': env.ALLOWED_ORIGIN,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'origin',
  };
}

function json(env: Env, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders(env) },
  });
}

export async function handleRequest(req: Request, env: Env, deps: TokenDeps): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname !== '/token') return json(env, 404, { error: 'not found' });

  const origin = req.headers.get('origin');
  if (origin !== null && origin !== env.ALLOWED_ORIGIN) {
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });
  if (req.method !== 'POST') return json(env, 405, { error: 'method not allowed' });

  const ip = req.headers.get('cf-connecting-ip') ?? 'unknown';
  if (rateLimited(ip, deps.now())) return json(env, 429, { error: 'too many requests' });

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return json(env, 400, { error: 'bad request' });
  }
  if (raw.length > MAX_BODY_CHARS) return json(env, 401, { error: 'unauthorized' });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json(env, 400, { error: 'bad request' });
  }

  const passcode = (parsed as { passcode?: unknown } | null)?.passcode;
  if (typeof passcode !== 'string' || passcode.length === 0) {
    return json(env, 401, { error: 'unauthorized' });
  }
  if (!(await passcodeMatches(passcode, env.PASSCODE))) {
    return json(env, 401, { error: 'unauthorized' });
  }

  try {
    return json(env, 200, { token: await deps.mint() });
  } catch {
    return json(env, 502, { error: 'could not create a session token' });
  }
}

// PROVIDER NOTES (request captured from @google/genai 2.31.0, checked 2026-10-24):
// - Ephemeral tokens: POST https://generativelanguage.googleapis.com/v1alpha/auth_tokens
//   with the API key in the x-goog-api-key header (Gemini Developer API, v1alpha only).
// - Body fields: uses, expireTime, newSessionExpireTime. The token string is `name` in the reply.
// - `uses` is 1 here: each new connection needs a fresh token (the app asks for one every time).
// - Plain fetch (no SDK) keeps this file tiny, so it can be pasted into Cloudflare's online editor.
const GOOGLE_TOKEN_URL = 'https://generativelanguage.googleapis.com/v1alpha/auth_tokens';

export function createGeminiMint(
  env: Env,
  fetchImpl: typeof fetch = fetch,
  now: () => number = () => Date.now(),
): () => Promise<string> {
  return async () => {
    const t = now();
    const res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        uses: 1,
        expireTime: new Date(t + 30 * 60_000).toISOString(),
        newSessionExpireTime: new Date(t + 60_000).toISOString(),
      }),
    });
    if (!res.ok) throw new Error(`Google token request failed (${res.status})`);
    const data = (await res.json()) as { name?: string };
    if (!data.name) throw new Error('Google returned no token');
    return data.name;
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return handleRequest(req, env, { mint: createGeminiMint(env), now: () => Date.now() });
  },
};
