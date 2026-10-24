import { BrowserMicSource } from './audio/micSource';
import { PlaybackQueue, WebAudioSink } from './audio/playbackQueue';
import { config } from './config';
import { SessionController, type SessionState } from './session/sessionController';
import { ScreenAwake } from './screenAwake';
import { fetchToken } from './tokenClient';
import { appendTranscript, renderView, setLevel, summarizeDelays, type TranscriptLine, type ViewModel } from './ui/view';
import { GeminiLiveAdapter } from './voice/geminiLiveAdapter';
import type { VoiceAdapter } from './voice/adapter';

const PASSCODE_KEY = 'home-voice-passcode';
const LANGUAGE_KEY = 'home-voice-language';
type Lang = 'auto' | 'en' | 'da';

function loadLanguage(): Lang {
  try {
    const v = localStorage.getItem(LANGUAGE_KEY);
    return v === 'en' || v === 'da' ? v : 'auto';
  } catch { return 'auto'; }
}
function saveLanguage(v: Lang): void {
  try { localStorage.setItem(LANGUAGE_KEY, v); } catch { /* fine */ }
}
let language: Lang = loadLanguage();

function loadJson<T>(key: string, fallback: T): T {
  try { return { ...fallback, ...JSON.parse(localStorage.getItem(key) ?? '{}') }; } catch { return fallback; }
}
function saveJson(key: string, v: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* fine */ }
}
const OPTIONS_KEY = 'home-voice-options';
let options = loadJson(OPTIONS_KEY, { voice: '', proactiveAudio: false });

function loadPasscode(): string {
  try { return localStorage.getItem(PASSCODE_KEY) ?? ''; } catch { return ''; }
}
function savePasscode(v: string): void {
  try { localStorage.setItem(PASSCODE_KEY, v); } catch { /* storage unavailable: fine */ }
}

// The one place that picks a provider. Adding another provider means one more case here.
function createAdapter(provider: typeof config.provider): VoiceAdapter {
  switch (provider) {
    case 'gemini':
      return new GeminiLiveAdapter();
  }
}

const root = document.getElementById('app')!;
const sink = new WebAudioSink();
const controller = new SessionController({
  adapter: createAdapter(config.provider),
  mic: new BrowserMicSource(),
  playback: new PlaybackQueue(sink, 24000),
  getToken: fetchToken,
  now: () => Date.now(),
  getLanguage: () => language,
  getOptions: () => options,
});

const awake = new ScreenAwake();
let passcode = loadPasscode();
let transcript: TranscriptLine[] = [];
let message: string | undefined;
let askPasscode = passcode === '';
let state: SessionState = controller.state;

function draw(): void {
  const model: ViewModel = {
    state,
    transcript,
    message,
    stats: summarizeDelays(controller.responseDelaysMs),
    events: controller.events,
    showPasscode: askPasscode,
    language,
    ...options,
  };
  renderView(root, model, {
    onToggle: () => {
      if (state === 'idle' || state === 'error' || state === 'ended') {
        if (passcode === '') {
          askPasscode = true;
          message = 'Enter the passcode first.';
          draw();
          return;
        }
        message = undefined;
        transcript = [];
        void sink.resume(); // must run inside the tap so the browser allows sound
        void controller.start(passcode);
      } else {
        controller.stop();
      }
    },
    onVoice: (v) => {
      options = { ...options, voice: v };
      saveJson(OPTIONS_KEY, options);
    },
    onExperiment: (key, on) => {
      options = { ...options, proactiveAudio: on };
      saveJson(OPTIONS_KEY, options);
    },
    onLanguage: (v) => {
      language = v;
      saveLanguage(v);
    },
    onPasscode: (v) => {
      passcode = v;
      savePasscode(v);
    },
  });
}

controller.onState((s) => {
  state = s;
  // Keep the screen on only while a conversation is running.
  if (s === 'connecting' || s === 'listening' || s === 'speaking') void awake.hold();
  else void awake.release();
  draw();
});
controller.onTranscript((e) => { transcript = appendTranscript(transcript, e); draw(); });
controller.onMessage((text, needsPasscode) => {
  message = text;
  if (needsPasscode) askPasscode = true;
  draw();
});

draw();

// Refresh the microphone meter a few times a second while a conversation is running.
setInterval(() => setLevel(root, state === 'listening' || state === 'speaking' ? controller.micLevel : 0), 150);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* installing is optional */ });
}
