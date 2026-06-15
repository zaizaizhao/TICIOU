import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readTextFileIfExists } from "../infra/fs.js";
import { SKILLHUB_LOCK_PATH } from "../project/paths.js";
import type { SkillHubLockEntry, SkillHubLockFile } from "./types.js";

export async function readSkillHubLock(
  targetRoot: string,
  profile: string,
  registry: string,
): Promise<SkillHubLockFile> {
  const path = join(targetRoot, ...SKILLHUB_LOCK_PATH.split("/"));
  const content = await readTextFileIfExists(path);
  if (content === undefined) {
    return createEmptyLock(profile, registry);
  }

  const parsed = JSON.parse(content) as Partial<SkillHubLockFile>;
  if (parsed.version !== 1 || !Array.isArray(parsed.skills)) {
    throw new Error("Unsupported .ticiou/.runtime/skillhub-lock.json format. Expected version: 1.");
  }

  if (parsed.profile !== profile || parsed.registry !== registry) {
    throw new Error(
      `SkillHub lock belongs to profile ${parsed.profile ?? "(unknown)"} and registry ${
        parsed.registry ?? "(unknown)"
      }, but current profile is ${profile} and registry is ${registry}.`,
    );
  }

  return {
    version: 1,
    profile,
    registry,
    generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : "",
    skills: parsed.skills.map(normalizeLockEntry),
  };
}

export async function writeSkillHubLock(targetRoot: string, lock: SkillHubLockFile): Promise<void> {
  const path = join(targetRoot, ...SKILLHUB_LOCK_PATH.split("/"));
  const tempPath = `${path}.tmp`;
  const nextLock: SkillHubLockFile = {
    ...lock,
    generatedAt: new Date().toISOString(),
    skills: lock.skills
      .slice()
      .sort((left, right) => `${left.namespace}/${left.slug}`.localeCompare(`${right.namespace}/${right.slug}`)),
  };

  await mkdir(dirname(path), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(nextLock, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

export function upsertLockEntry(lock: SkillHubLockFile, entry: SkillHubLockEntry): SkillHubLockFile {
  const key = lockKey(entry.namespace, entry.slug);
  const skills = lock.skills.filter((skill) => lockKey(skill.namespace, skill.slug) !== key);
  return {
    ...lock,
    skills: [...skills, entry],
  };
}

export function findLockEntry(
  lock: SkillHubLockFile,
  namespace: string,
  slug: string,
): SkillHubLockEntry | undefined {
  const key = lockKey(namespace, slug);
  return lock.skills.find((entry) => lockKey(entry.namespace, entry.slug) === key);
}

export function createEmptyLock(profile: string, registry: string): SkillHubLockFile {
  return {
    version: 1,
    profile,
    registry,
    generatedAt: "",
    skills: [],
  };
}

function normalizeLockEntry(value: unknown): SkillHubLockEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid SkillHub lock entry.");
  }

  const entry = value as Partial<SkillHubLockEntry>;
  if (
    typeof entry.namespace !== "string" ||
    typeof entry.slug !== "string" ||
    typeof entry.version !== "string" ||
    typeof entry.fingerprint !== "string" ||
    !Array.isArray(entry.installTargets) ||
    typeof entry.status !== "string"
  ) {
    throw new Error("Invalid SkillHub lock entry.");
  }

  return {
    namespace: entry.namespace,
    slug: entry.slug,
    selector: entry.selector,
    version: entry.version,
    versionId: entry.versionId,
    fingerprint: entry.fingerprint,
    visibility: entry.visibility,
    installTargets: entry.installTargets,
    status: entry.status,
    updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : "",
  } as SkillHubLockEntry;
}

function lockKey(namespace: string, slug: string): string {
  return `${namespace}/${slug}`;
}
