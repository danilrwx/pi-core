#!/usr/bin/env node
/**
 * Offline provenance check for vendored files.
 *
 * `check` verifies every file listed in third-party.lock.json by SHA-256 and
 * rejects unlisted files under vendor/ and licenses/. It never fetches upstream;
 * a deliberate upstream update must change the lock and the copied files together.
 * `lock` refreshes hashes for the existing entries after such a change.
 */

import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const LOCK_NAME = "third-party.lock.json";
export const LOCK_PATH = join(ROOT, LOCK_NAME);

function localPath(root, path) {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\0")) throw new Error(`invalid path: ${path}`);
  const absolute = resolve(root, path);
  const rootPath = resolve(root);
  if (absolute !== rootPath && !absolute.startsWith(`${rootPath}${sep}`)) throw new Error(`path escapes the repository: ${path}`);
  return absolute;
}

export async function hashFile(path) {
  const bytes = await readFile(path);
  return createHash("sha256").update(bytes).digest("hex");
}

async function walk(root, dir, out = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) {
    if (error?.code === "ENOENT") return out;
    throw error;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(root, path, out);
    else if (entry.isFile()) out.push(relative(root, path).split(sep).join("/"));
  }
  return out;
}

export async function loadLock(path = LOCK_PATH) {
  return JSON.parse(await readFile(path, "utf8"));
}

function validateShape(lock, errors) {
  if (!lock || typeof lock !== "object") { errors.push("lock must be an object"); return false; }
  if (lock.version !== 1) errors.push(`unsupported lock version: ${String(lock.version)}`);
  if (!lock.licenses || typeof lock.licenses !== "object" || Array.isArray(lock.licenses)) errors.push("licenses must be an object");
  if (!Array.isArray(lock.sources)) errors.push("sources must be an array");
  return errors.length === 0;
}

export async function verifyLock(lock, { root = ROOT, strict = true } = {}) {
  const errors = [];
  if (!validateShape(lock, errors)) return { errors, files: 0, sources: 0, licenses: 0 };
  const seen = new Set();
  let files = 0;

  for (const [path, expected] of Object.entries(lock.licenses)) {
    try {
      const actual = await hashFile(localPath(root, path));
      if (actual !== expected) errors.push(`license hash mismatch: ${path}`);
      seen.add(path);
      files++;
    } catch (error) { errors.push(`license ${path}: ${error.message}`); }
  }

  const ids = new Set();
  for (const source of lock.sources) {
    const id = source?.id;
    if (typeof id !== "string" || !id) { errors.push("source without id"); continue; }
    if (ids.has(id)) errors.push(`duplicate source id: ${id}`);
    ids.add(id);
    if (source.license && !(source.license in lock.licenses)) errors.push(`${id}: license is not listed: ${source.license}`);
    if (!Array.isArray(source.files)) { errors.push(`${id}: files must be an array`); continue; }
    for (const file of source.files) {
      const path = file?.path;
      if (!path) { errors.push(`${id}: file without path`); continue; }
      if (seen.has(path)) errors.push(`${id}: duplicate file path: ${path}`);
      seen.add(path);
      try {
        const absolute = localPath(root, path);
        const info = await stat(absolute);
        if (!info.isFile()) throw new Error("not a regular file");
        const actual = await hashFile(absolute);
        if (actual !== file.sha256) errors.push(`hash mismatch: ${path}`);
        files++;
      } catch (error) { errors.push(`${path}: ${error.message}`); }
    }
  }

  if (strict) {
    for (const path of await walk(root, join(root, "vendor"))) {
      if (!seen.has(path)) errors.push(`unlisted vendor file: ${path}`);
    }
    for (const path of await walk(root, join(root, "licenses"))) {
      if (!seen.has(path)) errors.push(`unlisted license file: ${path}`);
    }
  }

  return { errors, files, sources: lock.sources.length, licenses: Object.keys(lock.licenses).length };
}

export async function refreshLock(lock, { root = ROOT } = {}) {
  const errors = [];
  if (!validateShape(lock, errors)) throw new Error(errors.join("; "));
  for (const path of Object.keys(lock.licenses)) {
    lock.licenses[path] = await hashFile(localPath(root, path));
  }
  for (const source of lock.sources) {
    for (const file of source.files) file.sha256 = await hashFile(localPath(root, file.path));
  }
  return lock;
}

function print(result) {
  if (result.errors.length) {
    for (const error of result.errors) console.error(`  ${error}`);
    console.error(`\nthird-party: ${result.errors.length} error(s)`);
    return false;
  }
  console.log(`third-party: ${result.sources} sources, ${result.files} files, ${result.licenses} licenses verified`);
  return true;
}

async function main() {
  const command = process.argv[2] ?? "check";
  if (command === "check") {
    const result = await verifyLock(await loadLock());
    process.exit(print(result) ? 0 : 1);
  }
  if (command === "lock") {
    const lock = await loadLock();
    await refreshLock(lock);
    await writeFile(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o644 });
    console.log(`third-party: refreshed ${LOCK_NAME}`);
    return;
  }
  console.error("Usage: node scripts/third-party.mjs check|lock");
  process.exit(2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
