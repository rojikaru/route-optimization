import { requireEnvVar } from "~/lib/env";
import type { HeaderState, ProtobufFile } from "~/lib/types";

const MAX_FAILED_TRIES = Number.parseInt(requireEnvVar("MAX_FAILED_TRIES"));

export class RuntimeState {
  private readonly abortController: AbortController;
  private readonly abortedPromise: Promise<void>;

  private headers: HeaderState;
  private collectedFiles: ProtobufFile[];
  private failedTries: number;
  private uploadAfter: Temporal.Instant;

  constructor() {
    this.abortController = new AbortController();
    this.collectedFiles = [];
    this.failedTries = 0;
    this.uploadAfter = Temporal.Now.instant().add({ minutes: -1 });

    this.headers = {
      etag: null,
      lastModified: null,
    };

    this.abortedPromise = new Promise<void>((resolve) => {
      this.abortController.signal.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
  }

  get headerState() {
    return this.headers;
  }

  set headerState(state: HeaderState) {
    this.headers = state;
  }

  get nextUploadAt() {
    return this.uploadAfter;
  }

  set nextUploadAt(instant: Temporal.Instant) {
    this.uploadAfter = instant;
  }

  get protobufs() {
    return this.collectedFiles;
  }

  get failReason(): string | null {
    if (this.abortController.signal.aborted) {
      return "SIGTERM/SIGINT/SIGQUIT received";
    }
    if (this.failedTries > MAX_FAILED_TRIES) {
      return `Failed ${this.failedTries} times`;
    }
    return null;
  }

  get exitCode() {
    if (this.abortController.signal.aborted) {
      return 0;
    }
    return this.failedTries > MAX_FAILED_TRIES ? 1 : 0;
  }

  incrementFailedCount() {
    this.failedTries++;
  }

  resetFailedCount() {
    this.failedTries = 0;
  }

  abort() {
    this.abortController.abort();
  }

  waitUntilAborted() {
    return this.abortedPromise;
  }

  appendFile(protobufFile: ProtobufFile) {
    this.collectedFiles.push(protobufFile);
  }

  clearProtobufs() {
    this.collectedFiles = [];
  }
}
