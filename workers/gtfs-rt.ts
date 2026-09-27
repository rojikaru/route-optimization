import assert from "node:assert";
import process from "node:process";
import { S3Client } from "bun";

import { requireEnvVar } from "~/lib/env.ts";
import { dumpToDisk, uploadPending, mtime, hex } from "~/lib/file.ts";
import type { HeaderState, ProtobufFile } from "~/lib/types.ts";
import { healthCheck } from "~/lib/health";
import { nextInvocationInterval } from "~/lib/http-throttle";

import { RuntimeState } from "~/rt/state";

// Storage constants
const R2_ENDPOINT = requireEnvVar("S3_ENDPOINT");
const S3_ACCESS_KEY_ID = requireEnvVar("S3_ACCESS_KEY_ID");
const S3_SECRET_ACCESS_KEY = requireEnvVar("S3_SECRET_ACCESS_KEY");

// Application constants
const ARCHIVE_SIZE_LIMIT = Number.parseInt(requireEnvVar("ARCHIVE_SIZE_LIMIT"));
const FETCH_TIMEOUT_MS = Number.parseInt(requireEnvVar("FETCH_TIMEOUT_MS"));

// API-facing constants
const API_ENDPOINT = requireEnvVar("API_ENDPOINT");
const USER_AGENT = requireEnvVar("USER_AGENT");

const apiResponseToFile = async (
  response: Response,
  state: HeaderState,
): Promise<ProtobufFile | null> => {
  if (response.status === 304) {
    return null;
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch protobuf data: ${response.status} ${response.statusText}`,
    );
  }

  const data = await response.arrayBuffer();
  const stamp = mtime(state);
  const filename = `${stamp}-${await hex(data)}.pb`;
  return [filename, data];
};

const collectRt = async (
  state: HeaderState,
): Promise<[HeaderState, ProtobufFile | null]> => {
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

  const startTime = performance.now();
  const response = await fetch(API_ENDPOINT, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  console.info(response.status, performance.now() - startTime, "ms");

  const newState: HeaderState = {
    etag: response.headers.get("etag") ?? etag,
    lastModified: response.headers.get("last-modified") ?? lastModified,
  };
  const protobufFile = await apiResponseToFile(response, newState);
  return [newState, protobufFile];
};

const main = async () => {
  const r2 = new S3Client({
    endpoint: R2_ENDPOINT,
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
  });

  const runtimeState = new RuntimeState();
  for (const signal of ["SIGTERM", "SIGINT", "SIGQUIT"] as const) {
    process.on(signal, () => runtimeState.abort());
  }

  while (runtimeState.failReason === null) {
    try {
      await uploadPending(r2);
    } catch (error) {
      assert.ok(
        error instanceof Error,
        "Caught error is not an instance of Error",
      );
      console.error(
        `Error during uploadPending: ${error.toString()}. Is S3 down?`,
      );
    }

    try {
      const [headerState, protobufFile] = await collectRt(
        runtimeState.headerState,
      );
      runtimeState.headerState = headerState;
      runtimeState.resetFailedCount();

      if (protobufFile) {
        runtimeState.appendFile(protobufFile);
      }

      const sleepDuration = nextInvocationInterval();
      const moreThanOneMinute = sleepDuration > 60_000;
      const reachedArchiveLimit =
        runtimeState.protobufs.length >= ARCHIVE_SIZE_LIMIT;

      if (reachedArchiveLimit || moreThanOneMinute) {
        await dumpToDisk(runtimeState.protobufs);
        await healthCheck();
        runtimeState.clearProtobufs();
      }

      await Promise.race([
        Bun.sleep(sleepDuration),
        runtimeState.waitUntilAborted(),
      ]);
    } catch (error) {
      runtimeState.incrementFailedCount();

      assert.ok(
        error instanceof Error,
        "Caught error is not an instance of Error",
      );
      console.error(error.toString());
      await Bun.sleep(5_000);
    }
  }

  console.info("Dumping remaining protobufs to disk before exit...");
  await dumpToDisk(runtimeState.protobufs);
  await healthCheck();

  console.error(`Exiting due to: ${runtimeState.failReason}`);
  process.exit(runtimeState.exitCode);
};

if (import.meta.main) {
  await main();
}
