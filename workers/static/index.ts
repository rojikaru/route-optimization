import { rename, mkdir, rm } from "node:fs/promises";
import { $, type S3Client } from "bun";

import AdmZip from "adm-zip";

import { requireEnvVar } from "~/lib/env";
import { createR2Client, hash } from "~/lib/file";
import type { FileRecord, SemVer } from "~/lib/types";
import { healthCheck } from "~/lib/health";

const API_ENDPOINT = requireEnvVar("API_ENDPOINT");
const HEALTHCHECK_ENDPOINT = requireEnvVar("HEALTHCHECK_ENDPOINT");
const FETCH_TIMEOUT_MS = Number.parseInt(requireEnvVar("FETCH_TIMEOUT_MS"));
const USER_AGENT = requireEnvVar("USER_AGENT");

const TMP_DIR = "./tmp",
  GTFS_PART = "gtfs.part",
  GTFS_ZIP = "gtfs.zip",
  GTFS_REPORT = "report.json",
  LATEST_HASH_FILE = "static/latest";

/**
 * Downloads the GTFS Validator binary from GitHub releases if it doesn't already exist in the specified output folder.
 * The binary is downloaded from the official MobilityData GitHub repository.
 *
 * @param outFolder Where the binary would be stored
 * @param version Target version (pick at https://github.com/MobilityData/gtfs-validator/releases)
 * @returns The path to the downloaded GTFS Validator binary.
 * @throws Error if the download fails or if the binary cannot be saved to disk.
 * @see https://gtfs.org/getting-started/validate
 */
const downloadGtfsValidator = async (
  outFolder: string = "./bin",
  version: SemVer = "8.0.1",
): Promise<string> => {
  const targetName = `${outFolder}/gtfs-validator-${version}-cli`;
  const targetPath = `${targetName}.jar`;

  const targetFile = Bun.file(targetPath);
  if (await targetFile.exists()) {
    console.info(
      `GTFS Validator v${version} already exists at ${targetPath}, skipping.`,
    );
    return targetPath;
  }

  await mkdir(outFolder, { recursive: true });

  const url = `https://github.com/MobilityData/gtfs-validator/releases/download/v${version}/gtfs-validator-${version}-cli.jar`;

  console.info(`Downloading GTFS Validator v${version} from ${url}...`);
  const partialFile = `${targetName}.part`;
  const startTime = performance.now();

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to download GTFS Validator v${version}: ${response.status} ${response.statusText}`,
    );
  }

  await Bun.write(partialFile, response);
  await rename(partialFile, targetPath);

  const elapsedTimeMs = performance.now() - startTime;
  console.info(
    `Downloaded GTFS Validator v${version} in ${elapsedTimeMs.toFixed(2)} ms`,
  );

  return targetPath;
};

const runValidator = async (
  r2: S3Client,
  workdir: string,
  zipPath: string,
  timestamp: number,
  feedHash: string,
) => {
  const validatorPath = await downloadGtfsValidator();

  Bun.gc(true);

  // https://github.com/MobilityData/gtfs-validator/blob/master/docs/USAGE.md
  const result = await $`
    java -XX:+UseSerialGC -Xms140m -Xmx140m \
        -XX:+ExitOnOutOfMemoryError \
        -XX:MaxMetaspaceSize=64m -XX:ReservedCodeCacheSize=32m \
        -XX:TieredStopAtLevel=1 -Xss512k \
        -Djava.util.logging.config.file="${import.meta.dir}/validator-logging.properties" \
        -jar ${validatorPath} \
        -i ${zipPath} \
        -o ${workdir} \
        --country_code UA \
        --skip_validator_update
  `
    .quiet()
    .nothrow();

  if (result.exitCode !== 0) {
    console.error(
      `GTFS Validator failed with exit code ${result.exitCode}. Stderr: ${result.stderr}`,
    );
    throw new Error(
      `GTFS Validator failed with exit code ${result.exitCode}. Stderr: ${result.stderr}`,
    );
  }

  const reportFile = Bun.file(`${workdir}/${GTFS_REPORT}`);
  const report = await reportFile.json();

  const freeMemory = report.summary.memoryUsageRecords.reduce(
    (acc: number, record: { freeMemory: number }) => {
      return Math.min(acc, record.freeMemory);
    },
    Infinity,
  );

  if (freeMemory < 5 * 1024 * 1024) {
    console.warn(
      `GTFS Validator completed successfully, but free memory is low: ${freeMemory} bytes`,
    );
    await healthCheck(HEALTHCHECK_ENDPOINT, "failure", {
      message: "GTFS Validator completed successfully, but free memory is low.",
      freeMemory,
    });
  }

  console.info("GTFS Validator completed successfully.");

  const s3Prefix = `static/${timestamp}-${feedHash}`;
  const reportS3File = r2.file(`${s3Prefix}/${GTFS_REPORT}`);
  await reportS3File.write(reportFile, {
    type: "application/json",
    contentDisposition: `attachment`,
  });

  console.info(`Uploaded GTFS Validator report to ${s3Prefix}/${GTFS_REPORT}`);
};

const downloadFeed = async (workdir: string) => {
  const response = await fetch(API_ENDPOINT, {
    headers: {
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to download GTFS feed: ${response.status} ${response.statusText}`,
    );
  }

  await Bun.write(`${workdir}/${GTFS_PART}`, response);

  const zipPath = `${workdir}/${GTFS_ZIP}`;
  await rename(`${workdir}/${GTFS_PART}`, zipPath);

  return zipPath;
};

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const inspectZip = (zipPath: string): FileRecord[] =>
  new AdmZip(zipPath)
    .getEntries()
    .filter((e) => !e.isDirectory)
    .toSorted((a, b) => byName(a.entryName, b.entryName))
    .map((entry) => {
      const data = entry.getData();
      return {
        name: entry.entryName,
        bytes: data.byteLength,
        sha256: hash(data, "sha256"),
      };
    });

const treeHash = (files: FileRecord[]): string =>
  hash(
    files.map((f) => `${f.name}\t${f.bytes}\t${f.sha256}`).join("\n"),
    "sha256",
  );

type HashCheckResult =
  | { changed: true }
  | {
      changed: false;
      since: Temporal.Instant;
    };

const checkFeedStatus = async (
  r2: S3Client,
  feedHash: string,
): Promise<HashCheckResult> => {
  const file = r2.file(LATEST_HASH_FILE);
  try {
    const previousStamp = await file.text();
    const previousHash = previousStamp.split("-")[1];

    if (previousHash === feedHash) {
      console.info("Feed hash unchanged, skipping upload.");

      const stat = await file.stat();
      const lastModified = stat.lastModified.toTemporalInstant();
      return { changed: false, since: lastModified };
    }

    console.info(
      `Feed hash changed: ${previousHash} -> ${feedHash}, proceeding with upload.`,
    );
    return { changed: true };
  } catch (error) {
    console.info(
      "No previous feed hash found or error reading it, treating as changed.",
      error,
    );
    return { changed: true };
  }
};

const commit = async (
  r2: S3Client,
  zipPath: string,
  timestamp: number,
  feedHash: string,
) => {
  const stamp = `${timestamp}-${feedHash}`;
  const s3Prefix = `static/${stamp}`;

  const zipFile = Bun.file(zipPath);
  const zipS3File = r2.file(`${s3Prefix}/${GTFS_ZIP}`);
  await zipS3File.write(zipFile, {
    type: "application/zip",
    contentDisposition: `attachment`,
  });

  const file = r2.file(LATEST_HASH_FILE);
  await file.write(stamp, {
    type: "text/plain",
    contentDisposition: `attachment`,
  });

  console.info(`Committed new feed hash: ${feedHash}`);
};

const main = async () => {
  await healthCheck(HEALTHCHECK_ENDPOINT, "startup");

  const r2 = createR2Client();

  const timestamp = Temporal.Now.instant().epochMilliseconds;
  const workdir = `${TMP_DIR}/${timestamp}`;
  await mkdir(TMP_DIR, { recursive: true });

  try {
    const zipPath = await downloadFeed(workdir);
    const files = inspectZip(zipPath);
    const feedHash = treeHash(files);

    const status = await checkFeedStatus(r2, feedHash);
    if (!status.changed) {
      await healthCheck(HEALTHCHECK_ENDPOINT, "success", {
        message: "Feed unchanged, skipping upload.",
        currentHash: feedHash,
        lastUpdatedAt: status.since,
      });
      return;
    }

    await commit(r2, zipPath, timestamp, feedHash);
    await runValidator(r2, workdir, zipPath, timestamp, feedHash);

    await healthCheck(HEALTHCHECK_ENDPOINT, "success", {
      message: "Feed processed and committed successfully.",
      feedHash,
    });
  } catch (error) {
    console.error("Error occurred during processing:", error);
    await healthCheck(HEALTHCHECK_ENDPOINT, "failure", {
      message: "Error occurred during processing.",
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await rm(TMP_DIR, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  await main();
}
