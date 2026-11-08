import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { getImageDimensions } from "@earendil-works/pi-tui";

export interface ImageReference { path: string; start: number; end: number }
export interface PreviewImage { data: string; mimeType: string; label: string; path?: string }
export function imageReferences(text: string, cwd: string): ImageReference[] {
  const pattern = /@?(?:"([^"\n]+\.(?:png|jpe?g|gif|webp))"|'([^'\n]+\.(?:png|jpe?g|gif|webp))'|([^\s"'<>]+\.(?:png|jpe?g|gif|webp)))(?=\s|$)/gi;
  const found: ImageReference[] = [];
  for (const match of text.matchAll(pattern)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (/^[a-z]+:\/\//i.test(value)) continue; // Never fetch remote images for a UI preview.
    found.push({ path: resolve(cwd, value), start: match.index!, end: match.index! + match[0].length });
    if (found.length === 8) break;
  }
  return found;
}
export function removeReference(text: string, reference: ImageReference): string {
  return `${text.slice(0, reference.start)}${text.slice(reference.end)}`;
}

export async function previewData(data: string, mimeType: string, label: string, path?: string): Promise<PreviewImage | undefined> {
  if (data.length > 12 * 1024 * 1024) return;
  const size = getImageDimensions(data, mimeType);
  if (!size || size.widthPx * size.heightPx > 40_000_000) return;
  const resized = await resizeImage(Buffer.from(data, "base64"), mimeType, { maxWidth: 800, maxHeight: 600, maxBytes: 512 * 1024 });
  if (!resized && data.length > 700_000) return;
  return { data: resized?.data ?? data, mimeType: resized?.mimeType ?? mimeType, label: label.replace(/[\x00-\x1f\x7f]/g, "�").slice(0, 240), ...(path ? { path } : {}) };
}
export async function previewFile(path: string): Promise<PreviewImage | undefined> {
  const mimeType = /\.png$/i.test(path) ? "image/png" : /\.jpe?g$/i.test(path) ? "image/jpeg" : /\.gif$/i.test(path) ? "image/gif" : "image/webp";
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size > 8 * 1024 * 1024) return;
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return await previewData(bytes.subarray(0, offset).toString("base64"), mimeType, path, path);
  } catch { return; }
  finally { await file?.close(); }
}
