import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rmdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

export async function writeTextFileIfMissing(path: string, content: string): Promise<void> {
  if (await pathExists(path)) {
    return;
  }
  await writeTextFile(path, content);
}

export async function readTextFileIfExists(path: string): Promise<string | undefined> {
  if (!(await pathExists(path))) {
    return undefined;
  }
  return readFile(path, "utf8");
}

export async function removeFileIfExists(path: string): Promise<void> {
  await rm(path, { force: true });
}

export async function removeEmptyAncestorDirectories(startDirectory: string, stopDirectory: string): Promise<void> {
  let current = resolve(startDirectory);
  const stop = resolve(stopDirectory);

  while (current !== stop && current.startsWith(`${stop}/`)) {
    try {
      await rmdir(current);
    } catch (error) {
      if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTEMPTY")) {
        return;
      }
      throw error;
    }
    current = dirname(current);
  }
}

export function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

export function hashContent(content: string): string {
  return createHash("sha256").update(normalizeContent(content)).digest("hex");
}

export function toPosixPath(path: string): string {
  return path.split("\\").join("/");
}

export function normalizeRelativePath(relativePath: string): string {
  const posixPath = toPosixPath(relativePath);
  if (posixPath.includes("\0") || posixPath.startsWith("/")) {
    throw new Error(`Invalid relative path: ${relativePath}`);
  }

  const normalized = posix.normalize(posixPath);
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw new Error(`Invalid relative path: ${relativePath}`);
  }

  return normalized;
}

export function joinRelative(targetRoot: string, relativePath: string): string {
  return join(targetRoot, ...normalizeRelativePath(relativePath).split("/"));
}

export async function listDirectoryNames(path: string): Promise<string[]> {
  if (!(await pathExists(path))) {
    return [];
  }

  const entries = await readdir(path, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

export async function listFilesRecursive(root: string): Promise<string[]> {
  if (!(await pathExists(root))) {
    return [];
  }

  const files: string[] = [];

  async function visit(current: string, prefix: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    const sortedEntries = entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of sortedEntries) {
      const absolutePath = join(current, entry.name);
      const relativePath = prefix === "" ? entry.name : posix.join(prefix, entry.name);

      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      }
    }
  }

  await visit(root, "");
  return files;
}

export async function copyDirectoryContents(sourceRoot: string, destinationRoot: string): Promise<void> {
  if (!(await pathExists(sourceRoot))) {
    throw new Error(`Template directory does not exist: ${sourceRoot}`);
  }

  const files = await listFilesRecursive(sourceRoot);
  for (const relativePath of files) {
    const sourcePath = join(sourceRoot, ...relativePath.split("/"));
    const destinationPath = join(destinationRoot, ...relativePath.split("/"));
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }
}

export async function copyDirectoryContentsIfMissing(sourceRoot: string, destinationRoot: string): Promise<void> {
  if (!(await pathExists(sourceRoot))) {
    throw new Error(`Template directory does not exist: ${sourceRoot}`);
  }

  const files = await listFilesRecursive(sourceRoot);
  for (const relativePath of files) {
    const sourcePath = join(sourceRoot, ...relativePath.split("/"));
    const destinationPath = join(destinationRoot, ...relativePath.split("/"));
    if (await pathExists(destinationPath)) {
      continue;
    }
    await mkdir(dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
