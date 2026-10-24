import { GoogleGenAI } from '@google/genai';
import { base64ToPcm16, pcm16ToBase64 } from '../audio/pcm';
import { speechLanguageCodes } from '../persona';
import type {
  CloseReason,
  TranscriptEvent,
  VoiceAdapter,
  VoiceConfig,
  VoiceError,
  VoiceErrorKind,
} from './adapter';

// The slice of Google's live session that we use. Tests pass a mock of this.
export interface LiveSessionLike {
  sendRealtimeInput(p: { audio: { data: string; mimeType: string } }): void;
  close(): void;
}

export interface LiveCallbacks {
  onopen?: () => void;
  onmessage: (m: any) => void;
  onerror?: (e: any) => void;
  onclose?: (e: any) => void;
}

export type LiveConnect = (args: {
  token: string;
  model: string;
  config: Record<string, unknown>;
  callbacks: LiveCallbacks;
}) => Promise<LiveSessionLike>;

// Real connection: the short-lived token is used as the API key (Live API, v1alpha).
const defaultLiveConnect: LiveConnect = async ({ token, model, config, callbacks }) => {
  const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });
  return (await ai.live.connect({ model, config: config as any, callbacks })) as unknown as LiveSessionLike;
};

function classify(text: string): VoiceErrorKind {
  if (/RESOURCE_EXHAUSTED|\b429\b|quota/i.test(text)) return 'quota';
  if (/UNAUTHENTICATED|PERMISSION_DENIED|\b40[13]\b|API key|token/i.test(text)) return 'auth';
  if (/network|fetch|ECONN|socket/i.test(text)) return 'network';
  return 'unknown';
}

export class GeminiLiveAdapter implements VoiceAdapter {
  private session: LiveSessionLike | null = null;
  private resumeHandle: string | undefined;
  private userClosed = false;
  private closeFired = false;
  private goAway = false;

  private audioCb: (c: Int16Array) => void = () => {};
  private transcriptCb: (e: TranscriptEvent) => void = () => {};
  private interruptedCb: () => void = () => {};
  private errorCb: (e: VoiceError) => void = () => {};
  private closeCb: (r: CloseReason) => void = () => {};

  constructor(private connectLive: LiveConnect = defaultLiveConnect) {}

  async connect(c: VoiceConfig): Promise<void> {
    this.userClosed = false;
    this.closeFired = false;
    this.goAway = false;
    const config: Record<string, unknown> = {
      responseModalities: ['AUDIO'],
      systemInstruction: c.persona,
      inputAudioTranscription: { languageCodes: speechLanguageCodes(c.language) },
      // Wait a little longer before deciding you are done talking, so pauses to think do not trigger a reply.
      realtimeInputConfig: {
        automaticActivityDetection: { endOfSpeechSensitivity: 'END_SENSITIVITY_LOW', silenceDurationMs: 700 },
      },
      outputAudioTranscription: {},
      sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
      contextWindowCompression: { slidingWindow: {} },
    };
    if (c.voice) config.speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: c.voice } } };
    if (c.proactiveAudio) config.proactivity = { proactiveAudio: true };
    const session = await this.connectLive({
      token: c.token,
      model: c.model,
      config,
      callbacks: {
        onmessage: (m) => this.handleMessage(m),
        onerror: (e) => this.errorCb({ kind: classify(String(e?.message ?? e)), message: String(e?.message ?? e) }),
        onclose: (e) => this.handleClose(e),
      },
    });
    if (this.userClosed) {
      // close() was called while we were still connecting: shut the new session right away.
      try { session.close(); } catch { /* already closed */ }
      return;
    }
    this.session = session;
  }

  sendAudio(chunk: Int16Array): void {
    this.session?.sendRealtimeInput({ audio: { data: pcm16ToBase64(chunk), mimeType: 'audio/pcm;rate=16000' } });
  }

  onAudio(cb: (c: Int16Array) => void): void { this.audioCb = cb; }
  onTranscript(cb: (e: TranscriptEvent) => void): void { this.transcriptCb = cb; }
  onInterrupted(cb: () => void): void { this.interruptedCb = cb; }
  onError(cb: (e: VoiceError) => void): void { this.errorCb = cb; }
  onClose(cb: (r: CloseReason) => void): void { this.closeCb = cb; }

  close(): void {
    if (this.userClosed) return;
    this.userClosed = true;
    this.resumeHandle = undefined;
    const s = this.session;
    this.session = null;
    try { s?.close(); } catch { /* already closed */ }
    this.fireClose('user');
  }

  private fireClose(r: CloseReason): void {
    if (this.closeFired) return;
    this.closeFired = true;
    this.closeCb(r);
  }

  private handleClose(e: any): void {
    if (this.userClosed || this.closeFired) return;
    const reason = String(e?.reason ?? '');
    if (reason && classify(reason) === 'quota') this.errorCb({ kind: 'quota', message: reason });
    this.session = null;
    // A goAway notice means the server is ending the connection on purpose. If we hold a resumption
    // handle we can carry on seamlessly ('dropped' makes the app reconnect); otherwise the chat is over.
    this.fireClose(this.goAway && !this.resumeHandle ? 'timeout' : 'dropped');
  }

  private handleMessage(m: any): void {
    if (m?.goAway) this.goAway = true;
    const upd = m?.sessionResumptionUpdate;
    if (upd?.resumable && upd.newHandle) this.resumeHandle = upd.newHandle;

    const sc = m?.serverContent;
    if (!sc) return;
    for (const part of sc.modelTurn?.parts ?? []) {
      const inline = part?.inlineData;
      if (inline?.data && String(inline.mimeType ?? 'audio').startsWith('audio')) {
        this.audioCb(base64ToPcm16(inline.data));
      }
    }
    if (sc.interrupted) this.interruptedCb();
    if (sc.inputTranscription?.text) {
      this.transcriptCb({ role: 'user', text: sc.inputTranscription.text, final: Boolean(sc.inputTranscription.finished) });
    }
    if (sc.outputTranscription?.text) {
      this.transcriptCb({ role: 'assistant', text: sc.outputTranscription.text, final: Boolean(sc.outputTranscription.finished) });
    }
  }
}
