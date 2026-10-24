import type {
  CloseReason,
  TranscriptEvent,
  VoiceAdapter,
  VoiceConfig,
  VoiceError,
} from './adapter';

/** Test double: records what the app sends and lets tests emit provider events. */
export class FakeAdapter implements VoiceAdapter {
  sent: Int16Array[] = [];
  connectCalls: VoiceConfig[] = [];
  closeCalls = 0;

  private audioCb: (chunk: Int16Array) => void = () => {};
  private transcriptCb: (e: TranscriptEvent) => void = () => {};
  private interruptedCb: () => void = () => {};
  private errorCb: (e: VoiceError) => void = () => {};
  private closeCb: (r: CloseReason) => void = () => {};
  private nextConnectError: Error | null = null;

  async connect(c: VoiceConfig): Promise<void> {
    this.connectCalls.push(c);
    if (this.nextConnectError) {
      const err = this.nextConnectError;
      this.nextConnectError = null;
      throw err;
    }
  }

  sendAudio(chunk: Int16Array): void {
    this.sent.push(chunk);
  }

  onAudio(cb: (chunk: Int16Array) => void): void { this.audioCb = cb; }
  onTranscript(cb: (e: TranscriptEvent) => void): void { this.transcriptCb = cb; }
  onInterrupted(cb: () => void): void { this.interruptedCb = cb; }
  onError(cb: (e: VoiceError) => void): void { this.errorCb = cb; }
  onClose(cb: (r: CloseReason) => void): void { this.closeCb = cb; }

  close(): void {
    this.closeCalls++;
    this.closeCb('user');
  }

  failNextConnect(err: Error): void { this.nextConnectError = err; }
  emitAudio(chunk: Int16Array): void { this.audioCb(chunk); }
  emitTranscript(e: TranscriptEvent): void { this.transcriptCb(e); }
  emitInterrupted(): void { this.interruptedCb(); }
  emitError(e: VoiceError): void { this.errorCb(e); }
  emitClose(r: CloseReason): void { this.closeCb(r); }
}
