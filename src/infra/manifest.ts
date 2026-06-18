import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ManagedSource, Platform, ResourceKind } from "../domain/types.js";
import { MANIFEST_PATH } from "../project/paths.js";
import {
  hashContent,
  hashManagedContent,
  joinRelative,
  type ManagedContent,
  normalizeRelativePath,
  pathExists,
  removeEmptyAncestorDirectories,
  removeFileIfExists,
  writeManagedContentFile,
} from "./fs.js";

export interface ManagedFile {
  relativePath: string;
  content: ManagedContent;
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
  const staleFiles = options.removeStale ? staleManifestEntries(previousManifest.files, nextPaths) : [];

  await assertFilesCanBeWritten(options.targetRoot, nextFiles, previousFiles);
  await assertStaleFilesCanBeRemoved(options.targetRoot, staleFiles);

  const rollbackPlan = await createRollbackPlan(options.targetRoot, nextFiles, staleFiles);

  try {
    for (const file of nextFiles) {
      await writeManagedContentFile(joinRelative(options.targetRoot, file.relativePath), file.content);
    }

    if (options.removeStale) {
      await removeManifestEntries(options.targetRoot, staleFiles);
    }

    const manifest: RuntimeManifest = {
      version: 1,
      generatedAt: new Date().toISOString(),
      files: nextFiles.map((file) => ({
        relativePath: file.relativePath,
        hash: hashManagedContent(file.content),
        kind: file.kind,
        platform: file.platform,
        source: file.source,
      })),
    };

    await writeManifest(options.targetRoot, manifest);
    return manifest;
  } catch (error) {
    await rollbackManagedFileChanges(options.targetRoot, rollbackPlan);
    throw error;
  }
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
  const manifestDirectory = dirname(path);
  const tempPath = join(manifestDirectory, `.manifest-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  await mkdir(manifestDirectory, { recursive: true });

  try {
    await writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
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

    if (!(await managedFileMatchesManifest(targetRoot, previousFile))) {
      throw new Error(`Refusing to overwrite modified managed file: ${file.relativePath}`);
    }
  }
}

async function removeStaleFiles(targetRoot: string, previousFiles: ManifestEntry[], nextPaths: Set<string>): Promise<void> {
  await removeManifestEntries(targetRoot, staleManifestEntries(previousFiles, nextPaths));
}

async function assertStaleFilesCanBeRemoved(targetRoot: string, staleFiles: ManifestEntry[]): Promise<void> {
  for (const entry of staleFiles) {
    if (!(await managedFileMatchesManifest(targetRoot, entry))) {
      throw new Error(`Refusing to remove modified managed file: ${entry.relativePath}`);
    }
  }
}

async function removeManifestEntries(targetRoot: string, entries: ManifestEntry[]): Promise<void> {
  for (const entry of entries) {
    const path = joinRelative(targetRoot, entry.relativePath);
    if (!(await pathExists(path))) {
      continue;
    }

    if (!(await managedFileMatchesManifest(targetRoot, entry))) {
      throw new Error(`Refusing to remove modified managed file: ${entry.relativePath}`);
    }

    await removeFileIfExists(path);
    await removeEmptyAncestorDirectories(dirname(path), managedDirectoryBoundary(targetRoot, entry));
  }
}

function staleManifestEntries(previousFiles: ManifestEntry[], nextPaths: Set<string>): ManifestEntry[] {
  return previousFiles.filter((entry) => !nextPaths.has(entry.relativePath));
}

interface RollbackFileState extends ManifestEntry {
  content: Uint8Array | undefined;
}

async function createRollbackPlan(
  targetRoot: string,
  nextFiles: ManagedFile[],
  staleFiles: ManifestEntry[],
): Promise<RollbackFileState[]> {
  const rollbackFiles = new Map<string, RollbackFileState>();

  for (const file of nextFiles) {
    await addRollbackFileState(targetRoot, rollbackFiles, {
      relativePath: file.relativePath,
      hash: "",
      kind: file.kind,
      platform: file.platform,
      source: file.source,
    });
  }

  for (const entry of staleFiles) {
    await addRollbackFileState(targetRoot, rollbackFiles, entry);
  }

  return [...rollbackFiles.values()];
}

async function addRollbackFileState(
  targetRoot: string,
  rollbackFiles: Map<string, RollbackFileState>,
  entry: ManifestEntry,
): Promise<void> {
  if (rollbackFiles.has(entry.relativePath)) {
    return;
  }

  const path = joinRelative(targetRoot, entry.relativePath);
  rollbackFiles.set(entry.relativePath, {
    ...entry,
    content: (await pathExists(path)) ? await readFile(path) : undefined,
  });
}

async function rollbackManagedFileChanges(targetRoot: string, rollbackPlan: RollbackFileState[]): Promise<void> {
  for (const entry of rollbackPlan) {
    const path = joinRelative(targetRoot, entry.relativePath);
    if (entry.content === undefined) {
      await removeFileIfExists(path);
      continue;
    }

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, entry.content);
  }
}

async function managedFileMatchesManifest(targetRoot: string, entry: ManifestEntry): Promise<boolean> {
  const path = joinRelative(targetRoot, entry.relativePath);
  if (!(await pathExists(path))) {
    return true;
  }

  const existingContent = await readFile(path);
  return contentMatchesManifestHash(existingContent, entry.hash);
}

function contentMatchesManifestHash(content: Uint8Array, expectedHash: string): boolean {
  if (hashManagedContent(content) === expectedHash) {
    return true;
  }
  return hashContent(Buffer.from(content).toString("utf8")) === expectedHash;
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
