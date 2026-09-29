export interface HeaderState {
  etag: string | null;
  lastModified: string | null;
  contentType?: string | null;
  status?: number | null;
}

export type ProtobufFile = readonly [filename: string, data: Uint8Array];

export type HealthCheckMode = "success" | "failure" | "startup" | number;

export type SemVer = `${number}.${number}.${number}`;

export type FileRecord = { name: string; bytes: number; sha256: string };
