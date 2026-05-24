import { basename, join } from "node:path";

import type { Platform, TargetMode } from "../domain/types.js";
import { PLATFORMS } from "../domain/types.js";
import { readTextFileIfExists, writeTextFile } from "../infra/fs.js";
import { CONFIG_PATH } from "./paths.js";

export interface TiciouConfig {
  version: 1;
  projectName: string;
  platforms: Record<Platform, PlatformConfig>;
  target: {
    default: TargetMode;
    allowGitRoot: boolean;
  };
  profiles: {
    defaultUser?: string;
  };
  render: {
    prefix: string;
    conflictPolicy: "fail";
    removeStale: boolean;
  };
}

export interface PlatformConfig {
  enabled: boolean;
  scope: "project";
}

export function createDefaultConfig(targetRoot: string): TiciouConfig {
  return {
    version: 1,
    projectName: basename(targetRoot) || "ticiou-project",
    platforms: {
      claude: {
        enabled: false,
        scope: "project",
      },
      copilot: {
        enabled: false,
        scope: "project",
      },
    },
    target: {
      default: "cwd",
      allowGitRoot: true,
    },
    profiles: {
      defaultUser: undefined,
    },
    render: {
      prefix: "ticiou",
      conflictPolicy: "fail",
      removeStale: true,
    },
  };
}

export async function ensureConfig(targetRoot: string): Promise<TiciouConfig> {
  const existing = await readConfig(targetRoot);
  if (existing !== undefined) {
    return existing;
  }

  const config = createDefaultConfig(targetRoot);
  await writeConfig(targetRoot, config);
  return config;
}

export async function readConfig(targetRoot: string): Promise<TiciouConfig | undefined> {
  const content = await readTextFileIfExists(join(targetRoot, CONFIG_PATH));
  if (content === undefined) {
    return undefined;
  }

  return parseConfig(content, targetRoot);
}

export async function writeConfig(targetRoot: string, config: TiciouConfig): Promise<void> {
  await writeTextFile(join(targetRoot, CONFIG_PATH), serializeConfig(config));
}

export async function setPlatformEnabled(targetRoot: string, platform: Platform, enabled: boolean): Promise<TiciouConfig> {
  const config = await ensureConfig(targetRoot);
  config.platforms[platform] = {
    enabled,
    scope: "project",
  };
  await writeConfig(targetRoot, config);
  return config;
}

export function getEnabledPlatforms(config: TiciouConfig): Platform[] {
  return PLATFORMS.filter((platform) => config.platforms[platform].enabled);
}

function parseConfig(content: string, targetRoot: string): TiciouConfig {
  const config = createDefaultConfig(targetRoot);
  const lines = content.split(/\r?\n/);
  let section = "";
  let platform: Platform | undefined;

  for (const line of lines) {
    const topLevel = line.match(/^([a-z_]+):\s*(.*)$/);
    if (topLevel !== null) {
      section = topLevel[1] ?? "";
      platform = undefined;

      if (section === "version" && topLevel[2] !== "1") {
        throw new Error("Unsupported .ticiou/config.yaml version. Expected version: 1.");
      }
      continue;
    }

    if (section === "project") {
      const name = line.match(/^  name:\s*(.+)$/);
      if (name?.[1] !== undefined) {
        config.projectName = name[1];
      }
      continue;
    }

    if (section === "platforms") {
      const platformMatch = line.match(/^  (claude|copilot):\s*$/);
      if (platformMatch?.[1] !== undefined) {
        platform = platformMatch[1] as Platform;
        continue;
      }

      const enabledMatch = line.match(/^    enabled:\s*(true|false)\s*$/);
      if (platform !== undefined && enabledMatch?.[1] !== undefined) {
        config.platforms[platform].enabled = enabledMatch[1] === "true";
      }
      continue;
    }

    if (section === "target") {
      const defaultMatch = line.match(/^  default:\s*(cwd|git-root)\s*$/);
      if (defaultMatch?.[1] !== undefined) {
        config.target.default = defaultMatch[1] as TargetMode;
      }

      const allowGitRootMatch = line.match(/^  allow_git_root:\s*(true|false)\s*$/);
      if (allowGitRootMatch?.[1] !== undefined) {
        config.target.allowGitRoot = allowGitRootMatch[1] === "true";
      }
      continue;
    }

    if (section === "profiles") {
      const defaultUserMatch = line.match(/^  default_user:\s*(.+)$/);
      if (defaultUserMatch?.[1] !== undefined) {
        config.profiles.defaultUser = defaultUserMatch[1];
      }

      continue;
    }

    if (section === "render") {
      const prefixMatch = line.match(/^  prefix:\s*(.+)$/);
      if (prefixMatch?.[1] !== undefined) {
        config.render.prefix = prefixMatch[1];
      }

      const removeStaleMatch = line.match(/^  remove_stale:\s*(true|false)\s*$/);
      if (removeStaleMatch?.[1] !== undefined) {
        config.render.removeStale = removeStaleMatch[1] === "true";
      }
    }
  }

  return config;
}

function serializeConfig(config: TiciouConfig): string {
  const defaultUser = config.profiles.defaultUser === undefined ? "" : `  default_user: ${config.profiles.defaultUser}\n`;

  return `version: ${config.version}

project:
  name: ${config.projectName}

platforms:
  claude:
    enabled: ${config.platforms.claude.enabled}
    scope: ${config.platforms.claude.scope}
  copilot:
    enabled: ${config.platforms.copilot.enabled}
    scope: ${config.platforms.copilot.scope}

target:
  default: ${config.target.default}
  allow_git_root: ${config.target.allowGitRoot}

profiles:
${defaultUser.length === 0 ? "  default_user:\n" : defaultUser}

render:
  prefix: ${config.render.prefix}
  conflict_policy: ${config.render.conflictPolicy}
  remove_stale: ${config.render.removeStale}
`;
}
