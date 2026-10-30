import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Config } from "./config.js";

function isWithin(root: string, path: string) {
  const part = relative(root, path);
  return part !== "" && !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
}

export async function uploadBytes(
  input: { contentBase64?: string; serverFilePath?: string },
  config: Pick<Config, "uploadDirectory" | "maxUploadBytes">,
): Promise<Uint8Array> {
  if ((input.contentBase64 === undefined) === (input.serverFilePath === undefined)) {
    throw new Error("Provide exactly one of contentBase64 or serverFilePath");
  }
  if (input.contentBase64 !== undefined) {
    const value = input.contentBase64;
    if (value.length > 4 * Math.ceil(config.maxUploadBytes / 3)) throw new Error("Attachment exceeds VIKUNJA_MAX_UPLOAD_BYTES");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
      throw new Error("contentBase64 must be valid padded base64");
    }
    const bytes = Buffer.from(value, "base64");
    if (bytes.length > config.maxUploadBytes) throw new Error("Attachment exceeds VIKUNJA_MAX_UPLOAD_BYTES");
    return new Uint8Array(bytes);
  }
  const root = config.uploadDirectory;
  if (!root) throw new Error("Server-local uploads are disabled; configure VIKUNJA_UPLOAD_DIRECTORY to enable them");
  if (!input.serverFilePath?.trim()) throw new Error("serverFilePath must name an import file");
  const target = resolve(root, input.serverFilePath);
  if (!isWithin(root, target)) throw new Error("serverFilePath must stay inside VIKUNJA_UPLOAD_DIRECTORY");
  // The import directory must be writable only by its trusted operator. Reject links
  // at every level and check the opened descriptor, not just a path before reading.
  let cursor = root;
  for (const part of relative(root, target).split(sep)) {
    cursor = resolve(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Upload paths must not contain symbolic links");
  }
  if (!isWithin(root, await realpath(target))) throw new Error("Upload path escapes the import directory");
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await file.stat();
    const current = await lstat(target);
    if (!info.isFile() || info.nlink !== 1 || current.isSymbolicLink() || info.ino !== current.ino || info.dev !== current.dev || !isWithin(root, await realpath(target))) {
      throw new Error("Upload must be a regular file without links inside the import directory");
    }
    if (info.size > config.maxUploadBytes) throw new Error("Attachment exceeds VIKUNJA_MAX_UPLOAD_BYTES");
    const bytes = Buffer.alloc(Math.min(info.size + 1, config.maxUploadBytes + 1));
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, null);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    // A growing file is rejected too; it cannot make this read allocate without bound.
    if (used > info.size || used > config.maxUploadBytes) throw new Error("Attachment changed or exceeded its byte limit");
    return new Uint8Array(bytes.subarray(0, used));
  } finally { await file.close(); }
}
