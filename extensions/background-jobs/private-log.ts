import { closeSync, constants, fchmodSync, fstatSync, openSync, writeSync } from "node:fs";

/** Hard per-run cap shared by stdout/stderr; keep draining after the file fills. */
export const MAX_LOG_BYTES = 8 * 1024 * 1024;
const TRUNCATED = Buffer.from("\n[pi-core: log size limit reached; remaining output discarded]\n");

/** Synchronous, bounded writes keep two streams from racing past the same file's budget. */
export function appendPrivateLog(path: string, chunk: Buffer | string, maxBytes = MAX_LOG_BYTES): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error("Job log must be a regular file");
    fchmodSync(fd, 0o600);
    const room = Math.max(0, maxBytes - info.size);
    if (room === 0) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const output = bytes.length <= room ? bytes : Buffer.concat([
      bytes.subarray(0, Math.max(0, room - TRUNCATED.length)),
      TRUNCATED.subarray(0, room),
    ]).subarray(0, room);
    let offset = 0;
    while (offset < output.length) offset += writeSync(fd, output, offset, output.length - offset);
  } finally {
    closeSync(fd);
  }
}
