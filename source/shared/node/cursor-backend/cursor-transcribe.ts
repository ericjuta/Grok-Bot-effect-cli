import { createDeadlinePolicy, realClock, type DeadlinePolicy } from "../../../internal/scheduling.js";
import { AiService } from "../../../packages/proto/generated/aiserver/v1/aiserver_connect.js";
import {
  TranscribeAudioRequest,
  type TranscribeAudioResponse,
} from "../../../packages/proto/generated/aiserver/v1/aiserver_pb.js";
import { createSandCursorBackendClient } from "./cursor-inference.js";

export const TRANSCRIBE_TIMEOUT_MS = 60_000;

/** Language hints accepted by Cursor's Whisper transcription endpoint in 0.30. */
export const WHISPER_LANGUAGE_HINTS: ReadonlySet<string> = new Set([
  "af", "ar", "az", "be", "bg", "bs", "ca", "cs", "cy", "da", "de",
  "el", "en", "es", "et", "fa", "fi", "fr", "gl", "he", "hi", "hr",
  "hu", "hy", "id", "is", "it", "ja", "kk", "kn", "ko", "lt", "lv",
  "mi", "mk", "mr", "ms", "ne", "nl", "no", "pl", "pt", "ro", "ru",
  "sk", "sl", "sr", "sv", "sw", "ta", "th", "tl", "tr", "uk", "ur",
  "vi", "zh",
]);

const transcribeDeadline = createDeadlinePolicy(realClock, {
  name: "cursor-transcribe-audio",
  timeoutMs: TRANSCRIBE_TIMEOUT_MS,
});

export function toWhisperLanguageHint(language: string): string | undefined {
  const primary = language.trim().split("-")[0]?.toLowerCase() ?? "";
  return WHISPER_LANGUAGE_HINTS.has(primary) ? primary : undefined;
}

export function stripTranscriptionMimeParameters(mimeType: string): string {
  return (mimeType.split(";")[0] ?? mimeType).trim();
}

export class SandTranscribeEmptyAudioError extends Error {
  constructor() {
    super("Cannot transcribe empty audio.");
    this.name = "SandTranscribeEmptyAudioError";
  }
}

export interface TranscribeAudioClient {
  transcribeAudio(
    request: TranscribeAudioRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<Pick<TranscribeAudioResponse, "text" | "transcriptionTimeMs">>;
}

export interface SandTranscriptionOptions {
  readonly getCursorAccessToken: (options?: { readonly backendUrl?: string }) => Promise<string>;
  readonly getMachineId: () => Promise<string>;
  readonly onRequestId?: (requestId: string) => void;
  readonly clientForTesting?: TranscribeAudioClient;
  readonly createClient?: (
    credentials: Pick<
      SandTranscriptionOptions,
      "getCursorAccessToken" | "getMachineId" | "onRequestId"
    >,
  ) => TranscribeAudioClient;
  readonly deadline?: DeadlinePolicy;
}

export interface TranscriptionPort {
  transcribe(args: {
    readonly audio: Uint8Array;
    readonly mimeType: string;
    readonly language?: string;
  }): Promise<{ readonly text: string; readonly transcriptionTimeMs: number }>;
}

export class SandTranscriptionManager implements TranscriptionPort {
  private client?: TranscribeAudioClient;

  constructor(private readonly options: SandTranscriptionOptions) {}

  private getClient(): TranscribeAudioClient {
    if (this.options.clientForTesting != null) return this.options.clientForTesting;
    if (this.client == null) {
      this.client = this.options.createClient?.({
        getCursorAccessToken: this.options.getCursorAccessToken,
        getMachineId: this.options.getMachineId,
        ...(this.options.onRequestId == null
          ? {}
          : { onRequestId: this.options.onRequestId }),
      }) ?? createSandCursorBackendClient(AiService, {
        getAccessToken: this.options.getCursorAccessToken,
        getMachineId: this.options.getMachineId,
        onRequestId: this.options.onRequestId,
      } as Parameters<typeof createSandCursorBackendClient>[1]);
    }
    return this.client;
  }

  async transcribe(args: {
    readonly audio: Uint8Array;
    readonly mimeType: string;
    readonly language?: string;
  }): Promise<{ text: string; transcriptionTimeMs: number }> {
    if (args.audio.length === 0) throw new SandTranscribeEmptyAudioError();
    const language = args.language != null && args.language.length > 0
      ? toWhisperLanguageHint(args.language)
      : undefined;
    const response = await (this.options.deadline ?? transcribeDeadline).run(
      (signal) => this.getClient().transcribeAudio(new TranscribeAudioRequest({
        audio: new Uint8Array(args.audio),
        mimeType: stripTranscriptionMimeParameters(args.mimeType),
        ...(language == null ? {} : { language }),
      }), { signal }),
    );
    return {
      text: response.text,
      transcriptionTimeMs: Number(response.transcriptionTimeMs),
    };
  }
}
