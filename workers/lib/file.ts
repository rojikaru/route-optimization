import { rename } from "node:fs/promises";
import { S3Client, Glob, type SupportedCryptoAlgorithms } from "bun";

import { requireEnvVar } from "~/lib/env";
import type { HeaderState, ProtobufFile } from "~/lib/types";

const ETAG_REGEX = /^W\/"([0-9a-f]+)-(\d+)"$/;

/**
 * Computes the hexadecimal representation of the hash of the given data using the specified algorithm.
 *
 * @param data The input data as an ArrayBuffer to be hashed.
 * @param algorithm The hashing algorithm to use (default is "SHA-256").
 * @returns Hexadecimal string representation of the hash.
 */
export const hash = (
  data: Uint8Array | string,
  algorithm: SupportedCryptoAlgorithms = "sha256",
) => new Bun.CryptoHasher(algorithm).update(data).digest("hex");

/**
 * Typical ETag format: "W/"<bytesize>-<timestamp>""
 * We want to extract the second numeric part for the filename.
 *
 * If the ETag is not present or doesn't match the expected format,
 * rescue using lastModified if available
 *
 * @param state The current header state containing the ETag.
 * @returns The timestamp part of the ETag, lastModified timestamp, or `Date.now()` if neither is available.
 */
export const mtime = (state: HeaderState): number => {
  const match = ETAG_REGEX.exec(state.etag ?? "");

  // 0 is the whole regex, 1 is bytesize, 2 is timestamp
  const timestamp = match?.at(2);

  if (timestamp) {
    return Number.parseInt(timestamp);
  }

  const lastModifiedDate = state.lastModified
    ? new Date(state.lastModified).toTemporalInstant()
    : Temporal.Now.instant();
  return lastModifiedDate.epochMilliseconds;
};

/**
 * Create a date prefix in the format based on the timestamp provided.
 *
 * {@see https://duckdb.org/docs/lts/data/partitioning/hive_partitioning}
 *
 * @param timestamp The timestamp, milliseconds since the epoch, to derive the date prefix from.
 * @param tz The time zone to use for the date.
 * @returns The date prefix in the format `year={year}/month={month}/day={day}`.
 * @throws If the filename does not contain a valid timestamp.
 */
export const hivePrefixFromFilename = (
  millisSinceEpoch: string | number,
  tz: string = "UTC",
): `year=${number}/month=${number}/day=${number}` => {
  const numericMillis =
    typeof millisSinceEpoch === "string"
      ? Number.parseInt(millisSinceEpoch)
      : millisSinceEpoch;

  const instant = Temporal.Instant.fromEpochMilliseconds(numericMillis);
  const { year, month, day } = instant.toZonedDateTimeISO(tz);

  return `year=${year}/month=${month}/day=${day}`;
};

export const dumpToDisk = async (protobufFiles: ProtobufFile[]) => {
  if (protobufFiles.length === 0) {
    console.warn("No protobuf files to dump to disk.");
    return;
  }

  const fileMap = Object.fromEntries(protobufFiles);
  const archive = new Bun.Archive(fileMap, { compress: "gzip" });
  const checksum = hash(await archive.bytes());

  // SAFETY: Length >= 1 guaranteed by the if guard
  const firstFile = protobufFiles.at(0)![0];
  const lastFile = protobufFiles.at(-1)![0];

  const rangeStart = firstFile.split("-").at(0);
  const rangeEnd = lastFile.split("-").at(0);

  if (!rangeStart || !rangeEnd) {
    throw new Error(
      `Invalid filename format for range extraction: ${firstFile}, ${lastFile}`,
    );
  }

  const hivePrefix = hivePrefixFromFilename(rangeStart);
  const filename = `archives/${hivePrefix}/${rangeStart}-${rangeEnd}-${checksum}`;
  const tmpFilename = `${filename}.bin`;

  await Bun.write(tmpFilename, archive, { createPath: true });
  await rename(tmpFilename, `${filename}.tar.gz`);
};

export const uploadPending = async (
  s3: S3Client,
  limit: number = 5,
): Promise<number> => {
  const glob = new Glob("archives/**/*.tar.gz");
  let count = 0;

  for await (const path of glob.scan()) {
    if (count >= limit) {
      console.info(`Reached flush limit of ${limit}, stopping.`);
      break;
    }

    const file = Bun.file(path);
    const s3File = s3.file(path, {
      contentDisposition: `attachment`,
      contentEncoding: "gzip",
    });

    if (!(await file.exists())) {
      console.warn(`File ${path} does not exist, skipping.`);
      continue;
    }

    if (await s3File.exists()) {
      console.info(`File ${path} already exists in S3, skipping.`);
      continue;
    }

    console.info(`Flushing pending archive: ${path}`);
    await s3File.write(file, {
      type: "application/gzip",
    });
    await file.delete();
    count++;
  }

  return count;
};

export const createR2Client = () => {
  return new S3Client({
    endpoint: requireEnvVar("S3_ENDPOINT"),
    accessKeyId: requireEnvVar("S3_ACCESS_KEY_ID"),
    secretAccessKey: requireEnvVar("S3_SECRET_ACCESS_KEY"),
  });
};
