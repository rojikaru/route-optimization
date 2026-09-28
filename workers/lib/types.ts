export interface HeaderState {
  etag: string | null;
  lastModified: string | null;
}

export type ProtobufFile = readonly [
  filename: string,
  data: Uint8Array,
];

export type HealthCheckMode = "success" | "failure" | "startup" | number;
