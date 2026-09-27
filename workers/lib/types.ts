export interface HeaderState {
  etag: string | null;
  lastModified: string | null;
}

export type ProtobufFile = readonly [
  filename: string,
  data: ArrayBuffer,
];
