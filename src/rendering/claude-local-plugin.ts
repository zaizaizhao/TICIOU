import { readFile, rm } from "node:fs/promises";
import { join, posix, resolve as resolvePath } from "node:path";

import { slugify, userPluginName } from "../domain/resource-names.js";
import { defaultCommandRunner } from "../infra/command-runner.js";
import type { CommandRunner } from "../infra/command-runner.js";
import {
  listDirectoryNames,
  listFilesRecursive,
  pathExists,
  readTextFileIfExists,
  writeTextFile,
} from "../infra/fs.js";
import type { ManagedFile } from "../infra/manifest.js";
import { resolveRuntimeProfilesDirectory } from "../infra/profile-paths.js";
import type { TiciouConfig } from "../project/config.js";
import { normalizeSkillFrontmatterName } from "./skill-frontmatter.js";

export const CLAUDE_LOCAL_PROFILE_MARKETPLACE = "ticiou-local-profiles";
export const CLAUDE_LOCAL_PLUGIN_MARKETPLACE_ROOT =
  ".ticiou/.runtime/claude-plugin-marketplace";

export interface ClaudePluginSyncOptions {
  targetRoot: string;
  user: string;
  config: TiciouConfig;
  runner?: CommandRunner;
}

export interface ClaudePluginClearOptions {
  targetRoot: string;
  config: TiciouConfig;
  runner?: CommandRunner;
}

export interface ClaudePluginStatus {
  installed: boolean;
  enabled: boolean;
}

export async function collectClaudeLocalProfilePluginFiles(
  user: string,
  config: TiciouConfig,
): Promise<ManagedFile[]> {
  const profileSkillRoot = join(
    resolveRuntimeProfilesDirectory(),
    "users",
    user,
    "skills",
  );
  const skillNames = await listDirectoryNames(profileSkillRoot);
  const files: ManagedFile[] = [];
  const pluginName = userPluginName({ prefix: config.render.prefix, user });

  if (skillNames.length === 0) {
    return files;
  }

  files.push({
    relativePath: posix.join(
      CLAUDE_LOCAL_PLUGIN_MARKETPLACE_ROOT,
      ".claude-plugin/marketplace.json",
    ),
    content: `${JSON.stringify(createMarketplace(pluginName), null, 2)}\n`,
    kind: "skills",
    platform: "claude",
    source: "profile",
  });
  files.push({
    relativePath: posix.join(
      CLAUDE_LOCAL_PLUGIN_MARKETPLACE_ROOT,
      "plugins",
      pluginName,
      ".claude-plugin/plugin.json",
    ),
    content: `${JSON.stringify(createPluginManifest(pluginName, user), null, 2)}\n`,
    kind: "skills",
    platform: "claude",
    source: "profile",
  });

  for (const skillName of skillNames) {
    const skillRoot = join(profileSkillRoot, skillName);
    if (!(await pathExists(join(skillRoot, "SKILL.md")))) {
      continue;
    }

    const pluginSkillName = slugify(skillName);
    for (const resourceFile of await listFilesRecursive(skillRoot)) {
      const rawContent = await readFile(
        join(skillRoot, ...resourceFile.split("/")),
        "utf8",
      );
      const content =
        resourceFile === "SKILL.md"
          ? normalizeSkillFrontmatterName(rawContent, pluginSkillName)
          : rawContent;

      files.push({
        relativePath: posix.join(
          CLAUDE_LOCAL_PLUGIN_MARKETPLACE_ROOT,
          "plugins",
          pluginName,
          "skills",
          pluginSkillName,
          resourceFile,
        ),
        content,
        kind: "skills",
        platform: "claude",
        source: "profile",
      });
    }
  }

  return files;
}

export async function syncClaudeLocalProfilePluginSettings(
  targetRoot: string,
  user: string | undefined,
  config: TiciouConfig,
): Promise<void> {
  const settingsPath = join(targetRoot, ".claude", "settings.local.json");
  const settings = await readJsonObject(settingsPath);
  const marketplacePath = join(
    targetRoot,
    ...CLAUDE_LOCAL_PLUGIN_MARKETPLACE_ROOT.split("/"),
  );

  removeTiciouPluginSettings(settings);

  if (user !== undefined) {
    const pluginName = userPluginName({ prefix: config.render.prefix, user });
    setRecordValue(
      settings,
      "extraKnownMarketplaces",
      CLAUDE_LOCAL_PROFILE_MARKETPLACE,
      {
        source: {
          source: "directory",
          path: marketplacePath,
        },
      },
    );
    setRecordValue(
      settings,
      "enabledPlugins",
      `${pluginName}@${CLAUDE_LOCAL_PROFILE_MARKETPLACE}`,
      true,
    );
  }

  if (Object.keys(settings).length === 0) {
    await rm(settingsPath, { force: true });
    return;
  }

  await writeTextFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

export async function installClaudeLocalProfilePlugin(
  options: ClaudePluginSyncOptions,
): Promise<void> {
  const runner = options.runner ?? defaultCommandRunner;
  const marketplaceRoot = join(
    options.targetRoot,
    ...CLAUDE_LOCAL_PLUGIN_MARKETPLACE_ROOT.split("/"),
  );
  const pluginId = localProfilePluginId(options.config, options.user);

  await runner(
    "claude",
    ["plugin", "marketplace", "add", marketplaceRoot, "--scope", "local"],
    {
      cwd: options.targetRoot,
      env: process.env,
    },
  );
  await runner("claude", ["plugin", "install", pluginId, "--scope", "local"], {
    cwd: options.targetRoot,
    env: process.env,
  });
}

export async function uninstallClaudeLocalProfilePlugin(
  options: ClaudePluginClearOptions,
): Promise<void> {
  const runner = options.runner ?? defaultCommandRunner;
  const pluginIds = await listInstalledTiciouPluginIds(
    options.targetRoot,
    runner,
  );

  for (const pluginId of pluginIds) {
    await runner(
      "claude",
      ["plugin", "uninstall", pluginId, "--scope", "local"],
      {
        cwd: options.targetRoot,
        env: process.env,
      },
    );
  }
}

export async function getClaudeLocalProfilePluginStatus(
  targetRoot: string,
  pluginId: string,
  runner: CommandRunner = defaultCommandRunner,
): Promise<ClaudePluginStatus> {
  const entry = (await listInstalledTiciouPlugins(targetRoot, runner)).find(
    (value) => value.id === pluginId,
  );

  return {
    installed: entry !== undefined,
    enabled: entry?.enabled === true,
  };
}

export function localProfilePluginId(
  config: TiciouConfig,
  user: string,
): string {
  return `${userPluginName({ prefix: config.render.prefix, user })}@${CLAUDE_LOCAL_PROFILE_MARKETPLACE}`;
}

function createMarketplace(pluginName: string): unknown {
  return {
    name: CLAUDE_LOCAL_PROFILE_MARKETPLACE,
    owner: {
      name: "Ticiou",
    },
    description: "Ticiou local user profile plugins.",
    plugins: [
      {
        name: pluginName,
        description: "Ticiou active user profile skills.",
        source: `./plugins/${pluginName}`,
      },
    ],
  };
}

function createPluginManifest(pluginName: string, user: string): unknown {
  return {
    name: pluginName,
    description: `Ticiou user profile skills for ${user}.`,
  };
}

function removeTiciouPluginSettings(settings: Record<string, unknown>): void {
  const extraKnownMarketplaces = asRecord(settings.extraKnownMarketplaces);
  if (extraKnownMarketplaces !== undefined) {
    delete extraKnownMarketplaces[CLAUDE_LOCAL_PROFILE_MARKETPLACE];
    if (Object.keys(extraKnownMarketplaces).length === 0) {
      delete settings.extraKnownMarketplaces;
    }
  }

  const enabledPlugins = asRecord(settings.enabledPlugins);
  if (enabledPlugins !== undefined) {
    for (const key of Object.keys(enabledPlugins)) {
      if (key.endsWith(`@${CLAUDE_LOCAL_PROFILE_MARKETPLACE}`)) {
        delete enabledPlugins[key];
      }
    }
    if (Object.keys(enabledPlugins).length === 0) {
      delete settings.enabledPlugins;
    }
  }
}

async function listInstalledTiciouPluginIds(
  targetRoot: string,
  runner: CommandRunner,
): Promise<string[]> {
  return (await listInstalledTiciouPlugins(targetRoot, runner))
    .map((value) => value.id)
    .filter(
      (id): id is string =>
        typeof id === "string" &&
        id.endsWith(`@${CLAUDE_LOCAL_PROFILE_MARKETPLACE}`),
    );
}

async function listInstalledTiciouPlugins(
  targetRoot: string,
  runner: CommandRunner,
): Promise<Array<Record<string, unknown>>> {
  const result = await runner("claude", ["plugin", "list", "--json"], {
    cwd: targetRoot,
    env: process.env,
  });
  const parsed = JSON.parse(result.stdout) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .filter(
      (value): value is Record<string, unknown> =>
        typeof value === "object" && value !== null,
    )
    .filter((value) => isCurrentProjectLocalPlugin(value, targetRoot));
}

function isCurrentProjectLocalPlugin(
  entry: Record<string, unknown>,
  targetRoot: string,
): boolean {
  if (entry.scope !== "local") {
    return false;
  }

  return (
    typeof entry.projectPath !== "string" ||
    sameProjectPath(entry.projectPath, targetRoot)
  );
}

function sameProjectPath(left: string, right: string): boolean {
  const normalizedLeft = resolvePath(left);
  const normalizedRight = resolvePath(right);

  if (process.platform === "win32") {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }

  return normalizedLeft === normalizedRight;
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const content = await readTextFileIfExists(path);
  if (content === undefined) {
    return {};
  }

  const parsed = JSON.parse(content) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }

  return parsed as Record<string, unknown>;
}

function setRecordValue(
  settings: Record<string, unknown>,
  key: string,
  recordKey: string,
  value: unknown,
): void {
  const record = asRecord(settings[key]) ?? {};
  record[recordKey] = value;
  settings[key] = record;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}