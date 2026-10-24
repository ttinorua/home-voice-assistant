export interface AppConfig {
  provider: 'gemini';
  model: string;
  tokenUrl: string;
}

// Model code verified on Google's model page (2026-10-24): gemini-3.8-live is the
// current Live model; gemini-3.1-flash-live-preview is marked legacy.
// Override either value at build time with VITE_GEMINI_MODEL / VITE_TOKEN_URL.
export const config: AppConfig = {
  provider: 'gemini',
  model: import.meta.env?.VITE_GEMINI_MODEL ?? 'gemini-3.8-live',
  tokenUrl: import.meta.env?.VITE_TOKEN_URL ?? '/token',
};
