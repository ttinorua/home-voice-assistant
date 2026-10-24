// The swap point between the app and any voice provider.
// Audio contract: sendAudio takes 16 kHz mono PCM16; onAudio delivers 24 kHz mono PCM16.

export type Role = 'user' | 'assistant';

export interface TranscriptEvent {
  role: Role;
  text: string;
  final: boolean;
}

export type VoiceErrorKind = 'quota' | 'network' | 'auth' | 'unknown';

export interface VoiceError {
  kind: VoiceErrorKind;
  message: string;
}

export type CloseReason = 'user' | 'timeout' | 'dropped';

export interface VoiceConfig {
  token: string;
  persona: string;
  model: string;
  language: 'auto' | 'en' | 'da';
  voice?: string; // a Gemini voice name; empty or missing means the model default
  proactiveAudio?: boolean; // experiment: stay quiet when not spoken to
}

export interface VoiceAdapter {
  connect(c: VoiceConfig): Promise<void>;
  sendAudio(chunk: Int16Array): void;
  onAudio(cb: (chunk: Int16Array) => void): void;
  onTranscript(cb: (e: TranscriptEvent) => void): void;
  onInterrupted(cb: () => void): void;
  onError(cb: (e: VoiceError) => void): void;
  onClose(cb: (r: CloseReason) => void): void;
  close(): void;
}
