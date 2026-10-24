import { MESSAGES, type SessionEvent, type SessionState } from '../session/sessionController';
import { VOICES } from '../persona';
import type { Role, TranscriptEvent } from '../voice/adapter';

export interface TranscriptLine {
  role: Role;
  text: string;
}

export interface ViewModel {
  state: SessionState;
  transcript: TranscriptLine[];
  message?: string;
  stats?: string;
  events?: SessionEvent[];
  showPasscode: boolean;
  language?: 'auto' | 'en' | 'da';
  voice?: string;
  proactiveAudio?: boolean;
}

export interface ViewHandlers {
  onToggle(): void;
  onPasscode(v: string): void;
  onLanguage?(v: 'auto' | 'en' | 'da'): void;
  onVoice?(v: string): void;
  onExperiment?(key: 'proactive', on: boolean): void;
}

const STATUS: Record<SessionState, string> = {
  idle: 'Ready',
  connecting: 'Connecting…',
  listening: 'Listening',
  speaking: 'Speaking',
  error: 'Something went wrong',
  ended: 'Session ended',
};

/** Short summary of how long the assistant took to start replying, shown on screen for the phone test. */
export function summarizeDelays(ms: number[]): string {
  if (ms.length === 0) return '';
  const sorted = [...ms].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const sec = (v: number) => (v / 1000).toFixed(1);
  const turns = ms.length === 1 ? '1 turn' : `${ms.length} turns`;
  return `Reply delay: last ${sec(ms[ms.length - 1])} s, median ${sec(median)} s over ${turns}`;
}

/** Providers send transcripts in fragments: join consecutive fragments from the same speaker. */
export function appendTranscript(list: TranscriptLine[], e: TranscriptEvent): TranscriptLine[] {
  const last = list[list.length - 1];
  if (last && last.role === e.role) {
    return [...list.slice(0, -1), { role: e.role, text: last.text + e.text }];
  }
  return [...list, { role: e.role, text: e.text }];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, id?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (id) e.id = id;
  return e;
}

// Builds the page skeleton once; later calls only update it, so typing in the passcode box is never interrupted.
function ensureSkeleton(root: HTMLElement, h: ViewHandlers): void {
  if (root.querySelector('#toggle')) return;
  const title = el('h1');
  title.textContent = 'Home Voice';
  const status = el('p', 'status');
  const message = el('p', 'message');
  const hint = el('p', 'hint');
  const stats = el('p', 'stats');
  const passcode = el('input', 'passcode');
  passcode.type = 'password';
  passcode.placeholder = 'Passcode';
  passcode.autocomplete = 'current-password';
  passcode.addEventListener('input', () => h.onPasscode(passcode.value));
  const button = el('button', 'toggle');
  button.type = 'button';
  button.addEventListener('click', () => h.onToggle());
  const language = el('select', 'language');
  language.title = 'Language the assistant listens for and speaks. Applies when you tap Start.';
  for (const [value, label] of [['auto', 'English + Danish (auto)'], ['en', 'English only'], ['da', 'Danish only']]) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    language.append(o);
  }
  language.addEventListener('change', () => h.onLanguage?.(language.value as 'auto' | 'en' | 'da'));
  const voice = el('select', 'voice');
  voice.title = 'Voice of the assistant. Applies when you tap Start.';
  const dflt = document.createElement('option');
  dflt.value = '';
  dflt.textContent = 'Voice: default';
  voice.append(dflt);
  for (const v of VOICES) {
    const o = document.createElement('option');
    o.value = v.name;
    o.textContent = `Voice: ${v.name} (${v.gender})`;
    voice.append(o);
  }
  voice.addEventListener('change', () => h.onVoice?.(voice.value));
  const experiments = el('details', 'experiments');
  const expSummary = document.createElement('summary');
  expSummary.textContent = 'Experiments';
  experiments.append(expSummary);
  for (const [id, key, label] of [
    ['proactive', 'proactive', 'Stay quiet when I am not talking to it'],
  ] as const) {
    const wrap = document.createElement('label');
    const box = el('input', id);
    box.type = 'checkbox';
    box.addEventListener('change', () => h.onExperiment?.(key, box.checked));
    wrap.append(box, ` ${label}`);
    experiments.append(wrap, document.createElement('br'));
  }
  const level = el('progress', 'level');
  level.max = 1;
  level.value = 0;
  level.title = 'Microphone level: it should move when you speak';
  const transcript = el('ul', 'transcript');
  const log = el('details', 'log');
  const summary = document.createElement('summary');
  summary.textContent = 'Details';
  log.append(summary, document.createElement('ul'));
  root.append(title, status, message, hint, stats, level, language, voice, experiments, passcode, button, transcript, log);
}

export function renderView(root: HTMLElement, model: ViewModel, handlers: ViewHandlers): void {
  ensureSkeleton(root, handlers);
  const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;

  q('#status').textContent = STATUS[model.state];
  q('#message').textContent = model.message ?? '';
  const echoPossible = model.state === 'error' || model.state === 'listening' || model.state === 'speaking';
  q('#hint').textContent = echoPossible ? MESSAGES.headphones : '';
  q('#stats').textContent = model.stats ?? '';
  q<HTMLSelectElement>('#language').value = model.language ?? 'auto';
  q<HTMLSelectElement>('#voice').value = model.voice ?? '';
  q<HTMLInputElement>('#proactive').checked = Boolean(model.proactiveAudio);
  q<HTMLInputElement>('#passcode').hidden = !model.showPasscode;
  q('#toggle').textContent = model.state === 'idle' || model.state === 'error' || model.state === 'ended' ? 'Start' : 'Stop';
  root.dataset.state = model.state;

  const lines = (model.events ?? []).slice(-10);
  q('#log ul').replaceChildren(
    ...lines.map((e) => {
      const li = document.createElement('li');
      li.textContent = `${new Date(e.atMs).toLocaleTimeString('en-GB')} ${e.text}`;
      return li;
    }),
  );

  const list = q('#transcript');
  list.replaceChildren(
    ...model.transcript.map((line) => {
      const li = document.createElement('li');
      li.textContent = `${line.role === 'user' ? 'You' : 'Assistant'}: ${line.text}`;
      return li;
    }),
  );
}

/** Updates only the microphone meter, so it can refresh often without redrawing the whole page. */
export function setLevel(root: HTMLElement, level: number): void {
  const bar = root.querySelector<HTMLProgressElement>('#level');
  if (bar) bar.value = Math.max(0, Math.min(1, level));
}
