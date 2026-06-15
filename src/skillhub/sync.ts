import type { Platform } from "../domain/types.js";
import type { SkillHubSelection } from "../project/config.js";
import type { SkillHubClient } from "./client.js";
import { ensureCachedSkill, hasCachedSkill } from "./install.js";
import { findLockEntry, readSkillHubLock, upsertLockEntry, writeSkillHubLock } from "./lock.js";
import { explicitSkillSelections } from "./selection.js";
import type { SkillHubLockEntry, SkillHubLockFile } from "./types.js";
import { SkillHubError } from "./types.js";

export interface SyncSelectedSkillsOptions {
  targetRoot: string;
  profile: string;
  registry: string;
  client: SkillHubClient;
  selections: SkillHubSelection[];
  platforms: Platform[];
  autoRefresh: boolean;
  frozen?: boolean;
}

export interface SyncSelectedSkillsResult {
  lock: SkillHubLockFile;
  messages: string[];
  changed: boolean;
}

export async function syncSelectedSkills(options: SyncSelectedSkillsOptions): Promise<SyncSelectedSkillsResult> {
  let lock = await readSkillHubLock(options.targetRoot, options.profile, options.registry);
  const originalLock = lock;
  const messages: string[] = [];
  let changed = false;

  for (const selection of explicitSkillSelections(options.selections)) {
    const slug = selection.slug;
    if (slug === undefined) {
      continue;
    }

    const existing = findLockEntry(lock, selection.namespace, slug);
    if (options.frozen === true) {
      messages.push(
        ...(await checkFrozenSelection({
          targetRoot: options.targetRoot,
          registry: options.registry,
          client: options.client,
          selection,
          slug,
          autoRefresh: options.autoRefresh,
          existing,
        })),
      );
      continue;
    }

    if (
      existing !== undefined &&
      options.autoRefresh === false &&
      (await hasCachedSkill(options.targetRoot, options.registry, existing))
    ) {
      continue;
    }

    const version = options.autoRefresh ? selection.version : existing?.version ?? selection.version;
    const nextEntry = await installWithStatus({
      targetRoot: options.targetRoot,
      registry: options.registry,
      client: options.client,
      selection,
      slug,
      version,
      platforms: options.platforms,
      existing,
    });

    if (nextEntry !== undefined) {
      lock = upsertLockEntry(lock, nextEntry);
      changed = true;
      if (existing === undefined) {
        messages.push(`Installed SkillHub skill ${selection.namespace}/${slug}@${nextEntry.version}`);
      } else if (existing.fingerprint !== nextEntry.fingerprint || existing.version !== nextEntry.version) {
        messages.push(`Updated SkillHub skill ${selection.namespace}/${slug} ${existing.version} -> ${nextEntry.version}`);
      }
    }
  }

  if (changed && options.frozen !== true) {
    await writeSkillHubLock(options.targetRoot, lock);
  }

  return { lock: options.frozen === true ? originalLock : lock, messages, changed };
}

async function checkFrozenSelection(options: {
  targetRoot: string;
  registry: string;
  client: SkillHubClient;
  selection: SkillHubSelection;
  slug: string;
  autoRefresh: boolean;
  existing?: SkillHubLockEntry;
}): Promise<string[]> {
  try {
    const version = options.autoRefresh ? options.selection.version : options.existing?.version ?? options.selection.version;
    const resolved = await options.client.resolve(options.selection.namespace, options.slug, version);
    const messages: string[] = [];

    if (options.existing === undefined) {
      messages.push(`SkillHub skill ${options.selection.namespace}/${options.slug} is not locked; frozen mode skipped install`);
      return messages;
    }

    if (options.existing.version !== resolved.version || options.existing.fingerprint !== resolved.fingerprint) {
      messages.push(`SkillHub update available ${options.selection.namespace}/${options.slug} ${options.existing.version} -> ${resolved.version}`);
    }

    if (!(await hasCachedSkill(options.targetRoot, options.registry, options.existing))) {
      messages.push(`SkillHub skill ${options.selection.namespace}/${options.slug} cache is missing; frozen mode skipped install`);
    }

    return messages;
  } catch (error) {
    if (error instanceof SkillHubError && options.existing !== undefined) {
      if (error.status === 403 || error.status === 401) {
        return [`SkillHub skill ${options.selection.namespace}/${options.slug} is forbidden for the current token`];
      }
      if (error.status === 404) {
        return [`SkillHub skill ${options.selection.namespace}/${options.slug} is missing from the registry`];
      }
    }
    throw error;
  }
}

async function installWithStatus(options: {
  targetRoot: string;
  registry: string;
  client: SkillHubClient;
  selection: SkillHubSelection;
  slug: string;
  version?: string;
  platforms: Platform[];
  existing?: SkillHubLockEntry;
}): Promise<SkillHubLockEntry | undefined> {
  try {
    return await ensureCachedSkill({
      targetRoot: options.targetRoot,
      registry: options.registry,
      client: options.client,
      namespace: options.selection.namespace,
      slug: options.slug,
      version: options.version,
      selector: options.selection,
      platforms: options.platforms,
    });
  } catch (error) {
    if (error instanceof SkillHubError && options.existing !== undefined) {
      if (error.status === 403 || error.status === 401) {
        return { ...options.existing, status: "forbidden", updatedAt: new Date().toISOString() };
      }
      if (error.status === 404) {
        return { ...options.existing, status: "missing_remote", updatedAt: new Date().toISOString() };
      }
    }
    throw error;
  }
}
