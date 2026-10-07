import assert from "node:assert";
import process from "node:process";

import type { S3Client } from "bun";

import { requireEnvVar } from "~/lib/env.ts";
import {
  dumpToDisk,
  uploadPending,
  createR2Client,
  mtime,
  hash,
} from "~/lib/file.ts";
import type { HeaderState, ProtobufFile } from "~/lib/types.ts";
import { healthCheck } from "~/lib/health";
import { nextInvocationInterval } from "~/lib/http-throttle";

import { RuntimeState } from "~/collector/state";

// Application constants
const ARCHIVE_COUNT_LIMIT = Number.parseInt(
  requireEnvVar("ARCHIVE_COUNT_LIMIT"),
);
const FETCH_TIMEOUT_MS = Number.parseInt(requireEnvVar("FETCH_TIMEOUT_MS"));
const HEALTHCHECK_ENDPOINT = requireEnvVar("HEALTHCHECK_ENDPOINT");

// API-facing constants
const API_ENDPOINT = requireEnvVar("API_ENDPOINT");
const USER_AGENT = requireEnvVar("USER_AGENT");

const apiResponseToFile = (
  data: Uint8Array | null,
  state: HeaderState,
): ProtobufFile | null => {
  if (!data) return null;

  const stamp = mtime(state);
  const filename = `${stamp}-${hash(data)}.pb`;
  return [filename, data];
};

const collectRt = async (
  state: HeaderState,
  maxRetries: number = 3,
): Promise<[HeaderState, Uint8Array | null]> => {
  const { etag, lastModified } = state;
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
  };
  if (etag) {
    headers["If-None-Match"] = etag;
  }
  if (lastModified) {
    headers["If-Modified-Since"] = lastModified;
  }

  let lastError: unknown = null;
  for (let currentTry = 0; currentTry < maxRetries; currentTry++) {
    if (currentTry > 0) {
      await Bun.sleep(500 * currentTry);
    }

    try {
      const startTime = performance.now();
      const response = await fetch(API_ENDPOINT, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      console.info(response.status, performance.now() - startTime, "ms");

      const newState: HeaderState = {
        etag: response.headers.get("etag") ?? state.etag,
        lastModified:
          response.headers.get("last-modified") ?? state.lastModified,
      };

      if (response.status === 304) {
        return [newState, null];
      }
      if (!response.ok) {
        throw new Error(
          `Failed to fetch protobuf data: ${response.status} ${response.statusText}`,
        );
      }

      const data = await response.bytes();
      if (currentTry > 0) {
        console.info(`Successfully recovered on attempt ${currentTry + 1}`);
      }
      return [newState, data];
    } catch (error) {
      if (!(error instanceof TypeError)) {
        throw error;
      }
      lastError = error;
      console.warn(
        `Network error on attempt ${currentTry + 1}: ${error}. Retrying...`,
      );
    }
  }

  throw new Error("Failed to collect RT, maximum retries exceeded", {
    cause: lastError,
  });
};

const uploadTick = async (r2: S3Client, runtimeState: RuntimeState) => {
  const now = Temporal.Now.instant();
  if (Temporal.Instant.compare(now, runtimeState.nextUploadAt) < 0) {
    return;
  }

  try {
    const uploadedCount = await uploadPending(r2);
    if (uploadedCount > 0) {
      console.info(`Successfully uploaded ${uploadedCount} files to R2`);
      await healthCheck(HEALTHCHECK_ENDPOINT, "success", {
        source: "uploadLoop",
        uploadedCount,
      });
      return;
    }

    // Nothing to upload: don't hammer R2.
    runtimeState.nextUploadAt = now.add({ minutes: 10 });
  } catch (error) {
    runtimeState.nextUploadAt = now.add({ minutes: 10 });

    assert.ok(error instanceof Error);
    console.error(`Error in uploadLoop: ${error}. Is S3 down?`);

    await healthCheck(HEALTHCHECK_ENDPOINT, "failure", {
      source: "uploadLoop",
      message: error.toString(),
    });
  }
};

const uploadLoop = async (r2: S3Client, runtimeState: RuntimeState) => {
  while (runtimeState.failReason === null) {
    await uploadTick(r2, runtimeState);

    const sleepDurationMs =
      runtimeState.nextUploadAt.epochMilliseconds -
      Temporal.Now.instant().epochMilliseconds;

    await Promise.race([
      Bun.sleep(Math.max(sleepDurationMs, 0)),
      runtimeState.waitUntilAborted(),
    ]);
  }
};

const collectLoop = async (runtimeState: RuntimeState) => {
  while (runtimeState.failReason === null) {
    try {
      const [headerState, protobuf] = await collectRt(runtimeState.headerState);
      runtimeState.headerState = headerState;
      runtimeState.resetFailedCount();

      const protobufFile = apiResponseToFile(protobuf, headerState);
      if (protobufFile) {
        runtimeState.appendFile(protobufFile);
      }

      const sleepDurationMs = nextInvocationInterval();
      const sleepMoreThanOneMinute = sleepDurationMs > 60_000;
      const reachedArchiveLimit =
        runtimeState.protobufs.length >= ARCHIVE_COUNT_LIMIT;

      if (reachedArchiveLimit || sleepMoreThanOneMinute) {
        await dumpToDisk(runtimeState.protobufs);
        runtimeState.clearProtobufs();
      }

      if (sleepMoreThanOneMinute) {
        await healthCheck(HEALTHCHECK_ENDPOINT, "success", {
          source: "collectLoop",
          message: `Nightly health check`,
          sleepDurationMs,
        });
      }

      await Promise.race([
        Bun.sleep(sleepDurationMs),
        runtimeState.waitUntilAborted(),
      ]);
    } catch (error) {
      runtimeState.incrementFailedCount();

      assert.ok(
        error instanceof Error,
        "Caught error in collectLoop is not an instance of Error",
      );
      console.error(error.toString() + " (retrying in 5s)...");
      await Bun.sleep(5_000);
    }
  }
};

const main = async () => {
  const r2 = createR2Client();
  const runtimeState = new RuntimeState();

  for (const signal of ["SIGTERM", "SIGINT", "SIGQUIT"] as const) {
    process.on(signal, () => runtimeState.abort());
  }

  const upload = uploadLoop(r2, runtimeState);
  try {
    await collectLoop(runtimeState);
  } finally {
    console.info("Dumping remaining protobufs to disk before exit...");
    await dumpToDisk(runtimeState.protobufs);

    await healthCheck(HEALTHCHECK_ENDPOINT, runtimeState.exitCode, {
      source: "main",
      message: runtimeState.failReason,
    });

    console.error(`Exiting due to: ${runtimeState.failReason}`);

    console.info("Waiting for upload loop to finish...");
    await Promise.race([upload, Bun.sleep(10_000)]);

    process.exit(runtimeState.exitCode);
  }
};

if (import.meta.main) {
  await main();
}
