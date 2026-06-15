import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";

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

  if (!(await pathExists(join(cacheRoot, "SKILL.md")))) {
    const buffer = await options.client.download(options.namespace, options.slug, resolved.version);
    await rm(cacheRoot, { recursive: true, force: true });
    await extractZip(buffer, cacheRoot);
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
    if (entry.status === "disabled") {
      continue;
    }

    const cacheRoot = skillCacheRoot(options.targetRoot, options.registry, {
      namespace: entry.namespace,
      slug: entry.slug,
      version: entry.version,
    });
    if (!(await pathExists(join(cacheRoot, "SKILL.md")))) {
      continue;
    }

    const outputDirectoryName = skillHubOutputDirectoryName(entry.namespace, entry.slug);
    for (const resourceFile of await listFilesRecursive(cacheRoot)) {
      const contentBuffer = await readFile(join(cacheRoot, ...resourceFile.split("/")), "utf8");
      const content =
        resourceFile === "SKILL.md" ? normalizeSkillFrontmatterName(contentBuffer, outputDirectoryName) : contentBuffer;

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

export async function hasCachedSkill(targetRoot: string, registry: string, entry: SkillHubLockEntry): Promise<boolean> {
  return pathExists(
    join(
      skillCacheRoot(targetRoot, registry, {
        namespace: entry.namespace,
        slug: entry.slug,
        version: entry.version,
      }),
      "SKILL.md",
    ),
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
