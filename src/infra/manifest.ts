import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ManagedSource, Platform, ResourceKind } from "../domain/types.js";
import { MANIFEST_PATH } from "../project/paths.js";
import {
  hashContent,
  joinRelative,
  normalizeContent,
  normalizeRelativePath,
  pathExists,
  removeEmptyAncestorDirectories,
  removeFileIfExists,
  writeTextFile,
} from "./fs.js";

export interface ManagedFile {
  relativePath: string;
  content: string;
  kind: ResourceKind;
  platform: Platform;
  source: ManagedSource;
}

export interface WriteManagedFilesOptions {
  targetRoot: string;
  files: ManagedFile[];
  removeStale: boolean;
}

export interface RuntimeManifest {
  version: 1;
  generatedAt: string;
  files: ManifestEntry[];
}

export interface ManifestEntry {
  relativePath: string;
  hash: string;
  kind: ResourceKind;
  platform: Platform;
  source: ManagedSource;
}

export type ManifestEntryPredicate = (entry: ManifestEntry) => boolean;

export async function writeManagedFiles(options: WriteManagedFilesOptions): Promise<RuntimeManifest> {
  const previousManifest = await readManifest(options.targetRoot);
  const previousFiles = new Map(previousManifest.files.map((entry) => [entry.relativePath, entry]));
  const nextFiles = normalizeManagedFiles(options.files);
  const nextPaths = new Set(nextFiles.map((file) => file.relativePath));

  await assertFilesCanBeWritten(options.targetRoot, nextFiles, previousFiles);

  if (options.removeStale) {
    await removeStaleFiles(options.targetRoot, previousManifest.files, nextPaths);
  }

  for (const file of nextFiles) {
    await writeTextFile(joinRelative(options.targetRoot, file.relativePath), normalizeContent(file.content));
  }

  const manifest: RuntimeManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    files: nextFiles.map((file) => ({
      relativePath: file.relativePath,
      hash: hashContent(file.content),
      kind: file.kind,
      platform: file.platform,
      source: file.source,
    })),
  };

  await writeManifest(options.targetRoot, manifest);
  return manifest;
}

export async function clearManagedFiles(
  targetRoot: string,
  shouldClear: ManifestEntryPredicate,
): Promise<RuntimeManifest> {
  const previousManifest = await readManifest(targetRoot);
  const clearedFiles = previousManifest.files.filter((entry) => shouldClear(entry));
  const retainedFiles = previousManifest.files.filter((entry) => !shouldClear(entry));

  await removeStaleFiles(targetRoot, clearedFiles, new Set());

  const manifest: RuntimeManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    files: retainedFiles,
  };

  await writeManifest(targetRoot, manifest);
  return manifest;
}

export async function readManifest(targetRoot: string): Promise<RuntimeManifest> {
  const path = join(targetRoot, MANIFEST_PATH);
  if (!(await pathExists(path))) {
    return {
      version: 1,
      generatedAt: "",
      files: [],
    };
  }

  const content = await readFile(path, "utf8");
  const parsed = JSON.parse(content) as Partial<RuntimeManifest>;

  if (parsed.version !== 1 || !Array.isArray(parsed.files)) {
    throw new Error("Unsupported .ticiou/.runtime/manifest.json format. Expected version: 1.");
  }

  return {
    version: 1,
    generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : "",
    files: parsed.files.map((entry) => normalizeManifestEntry(entry)),
  };
}

async function writeManifest(targetRoot: string, manifest: RuntimeManifest): Promise<void> {
  const path = join(targetRoot, MANIFEST_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function normalizeManagedFiles(files: ManagedFile[]): ManagedFile[] {
  const seenPaths = new Set<string>();

  return files
    .map((file) => ({
      ...file,
      relativePath: normalizeRelativePath(file.relativePath),
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map((file) => {
      if (seenPaths.has(file.relativePath)) {
        throw new Error(`Multiple generated files target the same path: ${file.relativePath}`);
      }
      seenPaths.add(file.relativePath);
      return file;
    });
}

async function assertFilesCanBeWritten(
  targetRoot: string,
  files: ManagedFile[],
  previousFiles: Map<string, ManifestEntry>,
): Promise<void> {
  for (const file of files) {
    const path = joinRelative(targetRoot, file.relativePath);
    if (!(await pathExists(path))) {
      continue;
    }

    const previousFile = previousFiles.get(file.relativePath);
    if (previousFile === undefined) {
      throw new Error(`Refusing to overwrite unmanaged file: ${file.relativePath}`);
    }

    const existingContent = await readFile(path, "utf8");
    const existingHash = hashContent(existingContent);
    if (existingHash !== previousFile.hash) {
      throw new Error(`Refusing to overwrite modified managed file: ${file.relativePath}`);
    }
  }
}

async function removeStaleFiles(targetRoot: string, previousFiles: ManifestEntry[], nextPaths: Set<string>): Promise<void> {
  for (const entry of previousFiles) {
    if (nextPaths.has(entry.relativePath)) {
      continue;
    }

    const path = joinRelative(targetRoot, entry.relativePath);
    if (!(await pathExists(path))) {
      continue;
    }

    const existingContent = await readFile(path, "utf8");
    if (hashContent(existingContent) !== entry.hash) {
      throw new Error(`Refusing to remove modified managed file: ${entry.relativePath}`);
    }

    await removeFileIfExists(path);
    await removeEmptyAncestorDirectories(dirname(path), managedDirectoryBoundary(targetRoot, entry));
  }
}

function managedDirectoryBoundary(targetRoot: string, entry: ManifestEntry): string {
  if (entry.relativePath.startsWith(".ticiou/.runtime/claude-plugin-marketplace/")) {
    return joinRelative(targetRoot, ".ticiou/.runtime");
  }

  if (entry.kind === "skills") {
    if (entry.relativePath.startsWith(".claude/skills/")) {
      return joinRelative(targetRoot, ".claude/skills");
    }
    if (entry.relativePath.startsWith(".github/skills/")) {
      return joinRelative(targetRoot, ".github/skills");
    }
  }

  return joinRelative(targetRoot, dirname(entry.relativePath));
}

function normalizeManifestEntry(entry: unknown): ManifestEntry {
  if (typeof entry !== "object" || entry === null) {
    throw new Error("Invalid manifest entry.");
  }

  const value = entry as Partial<ManifestEntry>;
  if (
    typeof value.relativePath !== "string" ||
    typeof value.hash !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.platform !== "string" ||
    typeof value.source !== "string"
  ) {
    throw new Error("Invalid manifest entry.");
  }

  return {
    relativePath: normalizeRelativePath(value.relativePath),
    hash: value.hash,
    kind: value.kind,
    platform: value.platform,
    source: value.source,
  } as ManifestEntry;
}
