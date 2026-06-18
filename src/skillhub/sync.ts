import type { Platform } from "../domain/types.js";
import type { CommandMessage } from "../app/commands/types.js";
import type { SkillHubSelection } from "../project/config.js";
import type { SkillHubClient } from "./client.js";
import { ensureCachedSkill, hasCachedSkill } from "./install.js";
import { findLockEntry, readSkillHubLock, upsertLockEntry, writeSkillHubLock } from "./lock.js";
import { expandSkillSelections, selectorKey } from "./selection.js";
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
  messages: CommandMessage[];
  changed: boolean;
}

export async function syncSelectedSkills(options: SyncSelectedSkillsOptions): Promise<SyncSelectedSkillsResult> {
  let lock = await readSkillHubLock(options.targetRoot, options.profile, options.registry);
  const originalLock = lock;
  const messages: CommandMessage[] = [];
  let changed = false;
  const expandedSelections = await expandSkillSelections(options.client, options.selections);

  for (const selection of expandedSelections.selections) {
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
      existing.status === "installed" &&
      options.autoRefresh === false &&
      (await hasCachedSkill(options.targetRoot, options.registry, existing))
    ) {
      continue;
    }

    const version = options.autoRefresh ? selection.version : existing?.version ?? selection.version;
    const installResult = await installWithStatus({
      targetRoot: options.targetRoot,
      registry: options.registry,
      client: options.client,
      selection,
      slug,
      version,
      platforms: options.platforms,
      existing,
    });

    if (installResult !== undefined) {
      const nextEntry = installResult.entry;
      lock = upsertLockEntry(lock, nextEntry);
      changed = true;
      if (installResult.message !== undefined) {
        messages.push(installResult.message);
      } else if (existing === undefined) {
        messages.push(`Installed SkillHub skill ${selection.namespace}/${slug}@${nextEntry.version}`);
      } else if (existing.fingerprint !== nextEntry.fingerprint || existing.version !== nextEntry.version) {
        messages.push(`Updated SkillHub skill ${selection.namespace}/${slug} ${existing.version} -> ${nextEntry.version}`);
      }
    }
  }

  if (options.frozen !== true) {
    const disabledExplicitEntries = markUnselectedExplicitEntries(lock, expandedSelections.selections);
    if (disabledExplicitEntries.length > 0) {
      changed = true;
      messages.push(
        ...disabledExplicitEntries.map((entry) => ({
          text: `Disabled SkillHub skill ${entry.namespace}/${entry.slug} because it is no longer selected`,
          tone: "warning" as const,
        })),
      );
    }

    const missingFromSelectors = markSelectorMissingEntries(lock, expandedSelections.selectorResults);
    if (missingFromSelectors.length > 0) {
      changed = true;
      messages.push(
        ...missingFromSelectors.map((entry) => ({
          text: `SkillHub skill ${entry.namespace}/${entry.slug} is missing from selector results`,
          tone: "warning" as const,
        })),
      );
    }
  }

  if (changed && options.frozen !== true) {
    await writeSkillHubLock(options.targetRoot, lock);
  }

  return { lock: options.frozen === true ? originalLock : lock, messages, changed };
}

function markUnselectedExplicitEntries(
  lock: SkillHubLockFile,
  activeSelections: Array<{ namespace: string; slug?: string }>,
): SkillHubLockEntry[] {
  const activeKeys = new Set(
    activeSelections
      .filter((selection) => selection.slug !== undefined && selection.slug.length > 0)
      .map((selection) => lockKey(selection.namespace, selection.slug as string)),
  );
  const disabledEntries: SkillHubLockEntry[] = [];

  for (const entry of lock.skills) {
    if (!isExplicitLockEntry(entry) || activeKeys.has(lockKey(entry.namespace, entry.slug)) || entry.status === "disabled") {
      continue;
    }

    entry.status = "disabled";
    entry.updatedAt = new Date().toISOString();
    disabledEntries.push(entry);
  }

  return disabledEntries;
}

function isExplicitLockEntry(entry: SkillHubLockEntry): boolean {
  return entry.selector === undefined || (entry.selector.slug !== undefined && entry.selector.slug.length > 0);
}

function markSelectorMissingEntries(
  lock: SkillHubLockFile,
  selectorResults: Array<{ key: string; skills: Array<{ namespace: string; slug: string }> }>,
): SkillHubLockEntry[] {
  const missingEntries: SkillHubLockEntry[] = [];
  for (const selectorResult of selectorResults) {
    const activeKeys = new Set(selectorResult.skills.map((skill) => lockKey(skill.namespace, skill.slug)));
    for (const entry of lock.skills) {
      if (entry.selector === undefined || selectorKey(entry.selector) !== selectorResult.key) {
        continue;
      }
      if (activeKeys.has(lockKey(entry.namespace, entry.slug)) || entry.status === "missing_remote") {
        continue;
      }
      entry.status = "missing_remote";
      entry.updatedAt = new Date().toISOString();
      missingEntries.push(entry);
    }
  }
  return missingEntries;
}

async function checkFrozenSelection(options: {
  targetRoot: string;
  registry: string;
  client: SkillHubClient;
  selection: SkillHubSelection;
  slug: string;
  autoRefresh: boolean;
  existing?: SkillHubLockEntry;
}): Promise<CommandMessage[]> {
  try {
    const version = options.autoRefresh ? options.selection.version : options.existing?.version ?? options.selection.version;
    const resolved = await options.client.resolve(options.selection.namespace, options.slug, version);
    const messages: CommandMessage[] = [];

    if (options.existing === undefined) {
      messages.push(`SkillHub skill ${options.selection.namespace}/${options.slug} is not locked; frozen mode skipped install`);
      return messages;
    }

    if (options.existing.version !== resolved.version || options.existing.fingerprint !== resolved.fingerprint) {
      messages.push({
        text: `SkillHub update available ${options.selection.namespace}/${options.slug} ${options.existing.version} -> ${resolved.version}`,
        tone: "warning",
      });
    }

    if (!(await hasCachedSkill(options.targetRoot, options.registry, options.existing))) {
      messages.push({
        text: `SkillHub skill ${options.selection.namespace}/${options.slug} cache is missing; frozen mode skipped install`,
        tone: "warning",
      });
    }

    return messages;
  } catch (error) {
    if (error instanceof SkillHubError && options.existing !== undefined) {
      if (error.status === 403 || error.status === 401) {
        return [
          {
            text: `SkillHub skill ${options.selection.namespace}/${options.slug} is forbidden for the current token`,
            tone: "warning",
          },
        ];
      }
      if (error.status === 404) {
        return [
          {
            text: `SkillHub skill ${options.selection.namespace}/${options.slug} is missing from the registry`,
            tone: "warning",
          },
        ];
      }
      if (
        error.status === undefined &&
        (await hasCachedSkill(options.targetRoot, options.registry, options.existing))
      ) {
        return [
          {
            text: `SkillHub registry unreachable; frozen mode using cached ${options.selection.namespace}/${options.slug}@${options.existing.version}`,
            tone: "warning",
          },
        ];
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
}): Promise<{ entry: SkillHubLockEntry; message?: CommandMessage } | undefined> {
  try {
    return {
      entry: await ensureCachedSkill({
        targetRoot: options.targetRoot,
        registry: options.registry,
        client: options.client,
        namespace: options.selection.namespace,
        slug: options.slug,
        version: options.version,
        selector: options.selection,
        platforms: options.platforms,
      }),
    };
  } catch (error) {
    if (error instanceof SkillHubError && options.existing !== undefined) {
      if (error.status === 403 || error.status === 401) {
        return {
          entry: { ...options.existing, status: "forbidden", updatedAt: new Date().toISOString() },
          message: {
            text: `SkillHub skill ${options.selection.namespace}/${options.slug} is forbidden for the current token`,
            tone: "warning",
          },
        };
      }
      if (error.status === 404) {
        return {
          entry: { ...options.existing, status: "missing_remote", updatedAt: new Date().toISOString() },
          message: {
            text: `SkillHub skill ${options.selection.namespace}/${options.slug} is missing from the registry`,
            tone: "warning",
          },
        };
      }
      if (
        error.status === undefined &&
        (await hasCachedSkill(options.targetRoot, options.registry, options.existing))
      ) {
        return {
          entry: options.existing,
          message: {
            text: `SkillHub registry unreachable; using cached ${options.selection.namespace}/${options.slug}@${options.existing.version}`,
            tone: "warning",
          },
        };
      }
    }
    throw error;
  }
}

function lockKey(namespace: string, slug: string): string {
  return `${namespace}/${slug}`;
}
