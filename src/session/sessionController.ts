import type { PlaybackQueue } from '../audio/playbackQueue';
import { config } from '../config';
import { personaFor, type Language } from '../persona';
import { TokenError } from '../tokenClient';
import type { CloseReason, TranscriptEvent, VoiceAdapter, VoiceError } from '../voice/adapter';

export type SessionState = 'idle' | 'connecting' | 'listening' | 'speaking' | 'error' | 'ended';

export interface MicSource {
  /** Rejects with an Error named NotAllowedError when the user denies microphone access. */
  start(onChunk: (c: Int16Array) => void): Promise<void>;
  stop(): void;
  /** Optional: called when the microphone stops by itself (for example headphones disconnecting). */
  onEnded?(cb: () => void): void;
}

export const MESSAGES = {
  limit: 'limit reached, try later',
  sessionEnded: 'session ended, tap to continue',
  headphones: 'use headphones if it talks to itself',
  micDenied: 'Microphone access was denied. Allow the microphone for this site in your browser settings, then tap Start.',
  badPasscode: 'That passcode did not work. Enter it again.',
  micLost: 'The microphone stopped. If you were using Bluetooth headphones, check they are connected, then tap Start.',
  connectFailed: 'Could not connect. Check your internet connection and tap Start to try again.',
} as const;

export interface SessionDeps {
  adapter: VoiceAdapter;
  mic: MicSource;
  playback: PlaybackQueue;
  getToken: (passcode: string) => Promise<string>;
  now: () => number;
  /** Which language the person chose; read on every connect so a change applies on the next (re)connect. */
  getLanguage?: () => Language;
  /** Voice and experiment choices; read on every connect. */
  getOptions?: () => { voice?: string; proactiveAudio?: boolean };
}

const POLL_MS = 100;
// Mic chunks louder than this (RMS on a 16-bit scale) count as you speaking. Approximate on purpose.
const SPEECH_RMS = 800;

function rms(chunk: Int16Array): number {
  if (chunk.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
  return Math.sqrt(sum / chunk.length);
}

const MAX_EVENTS = 30;

export interface SessionEvent {
  atMs: number;
  text: string;
}
const RECONNECT_TRIES = 3;
const RECONNECT_DELAY_MS = 2000;
// A reconnected session must stay up this long before a later drop earns another reconnect.
const STABLE_MS = 30_000;

/** Runs one voice conversation: connect, stream the mic, play replies, recover or stop cleanly. */
export class SessionController {
  state: SessionState = 'idle';
  responseDelaysMs: number[] = [];
  micLevel = 0; // 0..1, how loud the microphone is right now
  events: SessionEvent[] = []; // short log shown on screen to help find problems

  private generation = 0; // bumped on every stop/teardown so late async work can tell it is stale
  private active = false;
  private passcode = '';
  private reconnectsLeft = 1;
  private reconnectedAt: number | null = null;
  private pendingClose: CloseReason | null = null; // a close that arrived while still connecting
  private previousAttempt: Promise<void> = Promise.resolve();
  private lastSpeechAt: number | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;

  private stateCbs: ((s: SessionState) => void)[] = [];
  private transcriptCbs: ((e: TranscriptEvent) => void)[] = [];
  private messageCbs: ((text: string, needsPasscode: boolean) => void)[] = [];

  constructor(private d: SessionDeps) {
    d.adapter.onAudio((c) => this.handleAudio(c));
    d.adapter.onTranscript((e) => this.handleTranscript(e));
    d.adapter.onInterrupted(() => this.handleInterrupted());
    d.adapter.onError((e) => this.handleError(e));
    d.adapter.onClose((r) => this.handleClose(r));
    d.mic.onEnded?.(() => this.handleMicEnded());
  }

  onState(cb: (s: SessionState) => void): void { this.stateCbs.push(cb); }
  onTranscript(cb: (e: TranscriptEvent) => void): void { this.transcriptCbs.push(cb); }
  onMessage(cb: (text: string, needsPasscode: boolean) => void): void { this.messageCbs.push(cb); }

  async start(passcode: string): Promise<void> {
    if (this.state === 'connecting' || this.state === 'listening' || this.state === 'speaking') return;
    const gen = ++this.generation;
    this.active = true;
    this.passcode = passcode;
    this.reconnectsLeft = 1;
    this.reconnectedAt = null;
    this.pendingClose = null;
    this.lastSpeechAt = null;
    this.setState('connecting');
    // Attempts run one at a time: a stale attempt (stopped by the user) finishes and cleans up
    // before the next one touches the shared adapter and microphone.
    const previous = this.previousAttempt;
    const mine = (async () => {
      await previous;
      if (gen !== this.generation) return;
      try {
        if (!(await this.open(gen))) return;
        await this.d.mic.start((c) => {
          if (!this.active) return;
          const level = rms(c);
          this.micLevel = Math.min(1, level / 8000);
          if (level > SPEECH_RMS) this.lastSpeechAt = this.d.now();
          this.d.adapter.sendAudio(c);
        });
        if (gen !== this.generation) {
          this.d.mic.stop();
          this.d.adapter.close();
          return;
        }
        this.becameLive(false);
      } catch (e) {
        if (gen !== this.generation) return;
        this.fail(e);
      }
    })();
    this.previousAttempt = mine.catch(() => {});
    return mine;
  }

  stop(): void {
    this.teardown('idle');
  }

  // Fetches a fresh token (tokens are single-use) and connects. Returns false if stopped meanwhile.
  private async open(gen: number): Promise<boolean> {
    const token = await this.d.getToken(this.passcode);
    if (gen !== this.generation) return false;
    const language = this.d.getLanguage?.() ?? 'auto';
    await this.d.adapter.connect({ token, persona: personaFor(language), model: config.model, language, ...this.d.getOptions?.() });
    if (gen !== this.generation) {
      this.d.adapter.close();
      return false;
    }
    return true;
  }

  // Called once a connection is up and the mic is running. A close that happened meanwhile is handled now.
  private becameLive(again: boolean): void {
    this.log(again ? 'reconnected' : 'connected');
    this.setState('listening');
    const early = this.pendingClose;
    this.pendingClose = null;
    if (early) this.handleClose(early);
  }

  private async reconnect(gen: number): Promise<void> {
    if (this.reconnectsLeft <= 0) {
      this.teardown('error', MESSAGES.connectFailed);
      return;
    }
    this.reconnectsLeft--;
    this.d.playback.flush();
    this.stopPoll();
    this.pendingClose = null;
    this.setState('connecting');
    for (let attempt = 1; attempt <= RECONNECT_TRIES; attempt++) {
      try {
        if (!(await this.open(gen))) return;
        if (gen !== this.generation) return;
        this.reconnectedAt = this.d.now();
        this.becameLive(true);
        return;
      } catch (e) {
        if (gen !== this.generation) return;
        const wrongPasscode = e instanceof TokenError && e.status === 401;
        if (attempt === RECONNECT_TRIES || wrongPasscode) {
          this.fail(e);
          return;
        }
        await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
        if (gen !== this.generation) return;
      }
    }
  }

  private fail(e: unknown): void {
    if (e instanceof TokenError && e.status === 401) {
      this.teardown('error', MESSAGES.badPasscode, true);
    } else if (e instanceof Error && e.name === 'NotAllowedError') {
      this.teardown('error', MESSAGES.micDenied);
    } else {
      this.teardown('error', MESSAGES.connectFailed);
    }
  }

  // Single exit path: releases the mic, silences playback, closes the connection.
  private teardown(next: SessionState, message?: string, needsPasscode = false): void {
    if (next === 'idle') {
      if (this.state !== 'idle') this.log('stopped');
    } else if (next === 'ended') {
      this.log('session ended');
    } else if (message) {
      this.log(`error: ${message}`);
    }
    this.micLevel = 0;
    this.generation++;
    this.active = false;
    this.stopPoll();
    this.d.mic.stop();
    this.d.playback.flush();
    this.d.adapter.close();
    this.setState(next);
    if (message) this.messageCbs.forEach((cb) => cb(message, needsPasscode));
  }

  private handleAudio(chunk: Int16Array): void {
    if (!this.active || this.state === 'connecting') return;
    if (this.state === 'listening') {
      if (this.lastSpeechAt !== null) {
        this.responseDelaysMs.push(this.d.now() - this.lastSpeechAt);
        this.lastSpeechAt = null;
      }
      this.setState('speaking');
      this.startPoll();
    }
    this.d.playback.enqueue(chunk);
  }

  private handleTranscript(e: TranscriptEvent): void {
    if (!this.active) return;
    this.transcriptCbs.forEach((cb) => cb(e));
  }

  private handleInterrupted(): void {
    if (!this.active) return;
    this.d.playback.flush();
    this.stopPoll();
    if (this.state === 'speaking') this.setState('listening');
  }

  private handleError(e: VoiceError): void {
    if (!this.active) return;
    this.teardown('error', e.kind === 'quota' ? MESSAGES.limit : MESSAGES.connectFailed);
  }

  private handleClose(reason: CloseReason): void {
    if (!this.active || reason === 'user') return;
    if (this.state === 'connecting') {
      this.pendingClose = reason; // handled as soon as the connection and mic are up
      return;
    }
    if (reason === 'timeout') {
      this.teardown('ended', MESSAGES.sessionEnded);
      return;
    }
    if (this.reconnectedAt !== null && this.d.now() - this.reconnectedAt >= STABLE_MS) {
      this.reconnectsLeft = 1; // the last reconnect held; a new drop earns a new attempt
    }
    if (this.reconnectsLeft > 0) this.log('connection dropped, reconnecting');
    void this.reconnect(this.generation);
  }

  private handleMicEnded(): void {
    if (!this.active) return;
    this.teardown('error', MESSAGES.micLost);
  }

  private log(text: string): void {
    this.events = [...this.events, { atMs: this.d.now(), text }].slice(-MAX_EVENTS);
  }

  private startPoll(): void {
    this.stopPoll();
    this.poll = setInterval(() => {
      if (this.state === 'speaking' && !this.d.playback.isPlaying()) {
        this.stopPoll();
        this.setState('listening');
      }
    }, POLL_MS);
  }

  private stopPoll(): void {
    if (this.poll !== null) clearInterval(this.poll);
    this.poll = null;
  }

  private setState(s: SessionState): void {
    if (this.state === s) return;
    this.state = s;
    this.stateCbs.forEach((cb) => cb(s));
  }
}
