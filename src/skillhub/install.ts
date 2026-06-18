import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";

import { unzipSync } from "fflate";

import { slugify } from "../domain/resource-names.js";
import type { Platform } from "../domain/types.js";
import { listFilesRecursive, pathExists } from "../infra/fs.js";
import type { ManagedFile } from "../infra/manifest.js";
import { platformResourceRoot } from "../platforms/registry.js";
import type { SkillHubSelection } from "../project/config.js";
import { SKILLHUB_CACHE_DIR } from "../project/paths.js";
import { normalizeSkillFrontmatterName } from "../rendering/skill-frontmatter.js";
import type { SkillHubClient } from "./client.js";
import type { ResolveResponse, SkillHubLockEntry } from "./types.js";

const CACHE_METADATA_FILE = ".ticiou-skillhub-cache.json";

export interface EnsureCachedSkillOptions {
  targetRoot: string;
  registry: string;
  client: SkillHubClient;
  namespace: string;
  slug: string;
  version?: string;
  selector?: SkillHubSelection;
  platforms: Platform[];
}

export async function ensureCachedSkill(options: EnsureCachedSkillOptions): Promise<SkillHubLockEntry> {
  const resolved = await options.client.resolve(options.namespace, options.slug, options.version);
  const cacheRoot = skillCacheRoot(options.targetRoot, options.registry, resolved);

  if (!(await cacheMatchesResolvedSkill(cacheRoot, resolved))) {
    const buffer = await options.client.download(options.namespace, options.slug, resolved.version);
    await replaceCachedSkill(buffer, cacheRoot, resolved);
  }

  const outputDirectoryName = skillHubOutputDirectoryName(options.namespace, options.slug);
  return {
    namespace: resolved.namespace,
    slug: resolved.slug,
    selector: options.selector,
    version: resolved.version,
    versionId: resolved.versionId,
    fingerprint: resolved.fingerprint,
    installTargets: options.platforms.map((platform) => ({
      agent: platform,
      path: posix.join(platformResourceRoot(platform, "skills"), outputDirectoryName),
    })),
    status: "installed",
    updatedAt: new Date().toISOString(),
  };
}

export async function collectSkillHubManagedFiles(options: {
  targetRoot: string;
  registry: string;
  lockEntries: SkillHubLockEntry[];
  platforms: Platform[];
}): Promise<ManagedFile[]> {
  const files: ManagedFile[] = [];

  for (const entry of options.lockEntries) {
    if (!shouldRenderLockEntry(entry)) {
      continue;
    }

    const cacheRoot = skillCacheRoot(options.targetRoot, options.registry, {
      namespace: entry.namespace,
      slug: entry.slug,
      version: entry.version,
    });
    if (!(await hasCachedSkill(options.targetRoot, options.registry, entry))) {
      continue;
    }

    const outputDirectoryName = skillHubOutputDirectoryName(entry.namespace, entry.slug);
    for (const resourceFile of await listFilesRecursive(cacheRoot)) {
      if (resourceFile === CACHE_METADATA_FILE) {
        continue;
      }

      const content =
        resourceFile === "SKILL.md"
          ? normalizeSkillFrontmatterName(
              await readFile(join(cacheRoot, ...resourceFile.split("/")), "utf8"),
              outputDirectoryName,
            )
          : await readFile(join(cacheRoot, ...resourceFile.split("/")));

      for (const platform of options.platforms) {
        files.push({
          relativePath: posix.join(platformResourceRoot(platform, "skills"), outputDirectoryName, resourceFile),
          content,
          kind: "skills",
          platform,
          source: "skillhub",
        });
      }
    }
  }

  return files;
}

function shouldRenderLockEntry(entry: SkillHubLockEntry): boolean {
  return entry.status === "installed" || entry.status === "update_available" || entry.status === "stale_cache";
}

export async function hasCachedSkill(targetRoot: string, registry: string, entry: SkillHubLockEntry): Promise<boolean> {
  return cacheMatchesResolvedSkill(
    skillCacheRoot(targetRoot, registry, {
      namespace: entry.namespace,
      slug: entry.slug,
      version: entry.version,
    }),
    entry,
  );
}

export function skillHubOutputDirectoryName(namespace: string, slug: string): string {
  return `skillhub-${slugify(namespace)}-${slugify(slug)}`;
}

function skillCacheRoot(
  targetRoot: string,
  registry: string,
  skill: Pick<ResolveResponse, "namespace" | "slug" | "version">,
): string {
  return join(
    targetRoot,
    ...SKILLHUB_CACHE_DIR.split("/"),
    registryHash(registry),
    skill.namespace,
    skill.slug,
    skill.version,
  );
}

function registryHash(registry: string): string {
  return createHash("sha256").update(registry).digest("hex").slice(0, 12);
}

async function extractZip(buffer: ArrayBuffer, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  const files = unzipSync(new Uint8Array(buffer));
  for (const [entryName, data] of Object.entries(files)) {
    const filePath = safeJoin(targetDir, entryName);
    if (entryName.endsWith("/")) {
      await mkdir(filePath, { recursive: true });
      continue;
    }
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
  }
}

interface SkillCacheMetadata {
  schemaVersion: 1;
  namespace: string;
  slug: string;
  version: string;
  fingerprint: string;
}

async function cacheMatchesResolvedSkill(
  cacheRoot: string,
  skill: Pick<ResolveResponse, "namespace" | "slug" | "version" | "fingerprint">,
): Promise<boolean> {
  if (!(await pathExists(join(cacheRoot, "SKILL.md")))) {
    return false;
  }

  const metadata = await readCacheMetadata(cacheRoot);
  return (
    metadata?.schemaVersion === 1 &&
    metadata.namespace === skill.namespace &&
    metadata.slug === skill.slug &&
    metadata.version === skill.version &&
    metadata.fingerprint === skill.fingerprint
  );
}

async function replaceCachedSkill(
  buffer: ArrayBuffer,
  cacheRoot: string,
  skill: Pick<ResolveResponse, "namespace" | "slug" | "version" | "fingerprint">,
): Promise<void> {
  const cacheParent = dirname(cacheRoot);
  const tempRoot = uniqueSiblingDirectory(cacheRoot, "tmp");
  const backupRoot = uniqueSiblingDirectory(cacheRoot, "backup");
  let backupCreated = false;

  await mkdir(cacheParent, { recursive: true });

  try {
    await extractZip(buffer, tempRoot);
    await writeCacheMetadata(tempRoot, {
      schemaVersion: 1,
      namespace: skill.namespace,
      slug: skill.slug,
      version: skill.version,
      fingerprint: skill.fingerprint,
    });

    if (await pathExists(cacheRoot)) {
      await rename(cacheRoot, backupRoot);
      backupCreated = true;
    }

    try {
      await rename(tempRoot, cacheRoot);
    } catch (error) {
      if (backupCreated) {
        await rename(backupRoot, cacheRoot).catch(() => undefined);
        backupCreated = false;
      }
      throw error;
    }

    if (backupCreated) {
      await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    if (backupCreated && !(await pathExists(cacheRoot))) {
      await rename(backupRoot, cacheRoot).catch(() => undefined);
    } else {
      await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

async function readCacheMetadata(cacheRoot: string): Promise<SkillCacheMetadata | undefined> {
  const metadataPath = join(cacheRoot, CACHE_METADATA_FILE);
  if (!(await pathExists(metadataPath))) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(await readFile(metadataPath, "utf8")) as Partial<SkillCacheMetadata>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.namespace !== "string" ||
      typeof parsed.slug !== "string" ||
      typeof parsed.version !== "string" ||
      typeof parsed.fingerprint !== "string"
    ) {
      return undefined;
    }
    return parsed as SkillCacheMetadata;
  } catch {
    return undefined;
  }
}

async function writeCacheMetadata(cacheRoot: string, metadata: SkillCacheMetadata): Promise<void> {
  await writeFile(join(cacheRoot, CACHE_METADATA_FILE), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

function uniqueSiblingDirectory(path: string, prefix: string): string {
  return join(dirname(path), `.${prefix}-${basename(path)}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function safeJoin(targetDir: string, entryName: string): string {
  if (isAbsolute(entryName)) {
    throw new Error(`Unsafe SkillHub package entry path: ${entryName}`);
  }

  const root = resolve(targetDir);
  const target = resolve(root, entryName);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Unsafe SkillHub package entry path: ${entryName}`);
  }
  return target;
}
