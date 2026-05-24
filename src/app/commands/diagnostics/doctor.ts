import { join } from "node:path";

import { PLATFORMS } from "../../../domain/types.js";
import type { Platform } from "../../../domain/types.js";
import { joinRelative, pathExists, readTextFileIfExists } from "../../../infra/fs.js";
import { readManifest } from "../../../infra/manifest.js";
import { resolveRuntimeProfilesDirectory } from "../../../infra/profile-paths.js";
import { describePlatform, platformResourceRoot, platformSkillRoot } from "../../../platforms/registry.js";
import { readConfig } from "../../../project/config.js";
import { TICIOU_DIR } from "../../../project/paths.js";
import {
  CLAUDE_LOCAL_PLUGIN_MARKETPLACE_ROOT,
  CLAUDE_LOCAL_PROFILE_MARKETPLACE,
  getClaudeLocalProfilePluginStatus,
  localProfilePluginId,
} from "../../../rendering/claude-local-plugin.js";
import { userPluginName } from "../../../domain/resource-names.js";
import { getStatus } from "./status.js";
import type { CommandOptions, DoctorResult } from "../types.js";

export async function doctorProject(options: CommandOptions): Promise<DoctorResult> {
  const status = await getStatus(options);
  const config = await readConfig(status.targetRoot);
  const messages: string[] = [];
  let ok = true;

  if (!(await pathExists(join(status.targetRoot, TICIOU_DIR, "config.yaml")))) {
    return {
      targetRoot: status.targetRoot,
      ok: false,
      messages: ["Ticiou is not initialized in this target. Run ticiou init first."],
    };
  }

  if (config === undefined) {
    return {
      targetRoot: status.targetRoot,
      ok: false,
      messages: ["Ticiou is not initialized in this target. Run ticiou init first."],
    };
  }

  for (const platform of PLATFORMS) {
    if (!status.enabledPlatforms.includes(platform)) {
      continue;
    }

    if (await pathExists(join(status.targetRoot, platformSkillRoot(platform)))) {
      messages.push(`${describePlatform(platform)} adapter installed`);
    } else {
      ok = false;
      messages.push(`${describePlatform(platform)} adapter is enabled but its skill directory is missing`);
    }

    ok = (await checkPlatformDirectories(status.targetRoot, platform, messages)) && ok;
    ok = (await checkPlatformHooks(status.targetRoot, platform, messages)) && ok;
    if (platform === "claude") {
      ok =
        (await checkClaudeLocalProfilePlugin(
          status.targetRoot,
          status.currentProfile,
          config,
          messages,
          options.runner,
        )) && ok;
    }
  }

  if (status.currentProfile === undefined) {
    messages.push("No active profile. Run ticiou use -u <user>.");
  } else {
    messages.push(`Active profile: ${status.currentProfile}`);
    if (!(await pathExists(join(resolveRuntimeProfilesDirectory(), "users", status.currentProfile)))) {
      ok = false;
      messages.push(`Active profile ${status.currentProfile} was not found in packaged Ticiou profiles`);
    }
  }

  ok = (await checkManifestFiles(status.targetRoot, messages)) && ok;

  if (status.enabledPlatforms.includes("copilot")) {
    messages.push("For Copilot cloud agent, run Ticiou at the repository root or pass --target git-root.");
  }

  return {
    targetRoot: status.targetRoot,
    ok,
    messages,
  };
}

async function checkClaudeLocalProfilePlugin(
  targetRoot: string,
  currentProfile: string | undefined,
  config: NonNullable<Awaited<ReturnType<typeof readConfig>>>,
  messages: string[],
  runner: CommandOptions["runner"],
): Promise<boolean> {
  const settingsContent = await readTextFileIfExists(join(targetRoot, ".claude", "settings.local.json"));
  const marketplaceRoot = joinRelative(targetRoot, CLAUDE_LOCAL_PLUGIN_MARKETPLACE_ROOT);

  if (currentProfile === undefined) {
    if (settingsContent !== undefined || (await pathExists(marketplaceRoot))) {
      messages.push("Claude local profile plugin remains configured without an active profile");
      return false;
    }
    return true;
  }

  if (settingsContent === undefined) {
    messages.push("Missing Claude local profile plugin settings: .claude/settings.local.json");
    return false;
  }

  let settings: Record<string, unknown>;
  try {
    const parsed = JSON.parse(settingsContent) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    settings = parsed as Record<string, unknown>;
  } catch {
    messages.push("Claude local profile plugin settings are not valid JSON: .claude/settings.local.json");
    return false;
  }

  const pluginName = userPluginName({ prefix: config.render.prefix, user: currentProfile });
  const pluginId = localProfilePluginId(config, currentProfile);
  const enabledPlugins = asRecord(settings.enabledPlugins);
  const extraKnownMarketplaces = asRecord(settings.extraKnownMarketplaces);
  const marketplace = asRecord(extraKnownMarketplaces?.[CLAUDE_LOCAL_PROFILE_MARKETPLACE]);
  const source = asRecord(marketplace?.source);
  let ok = true;

  if (enabledPlugins?.[pluginId] !== true) {
    ok = false;
    messages.push(`Claude local profile plugin is not enabled: ${pluginId}`);
  }

  if (source?.source !== "directory" || source.path !== marketplaceRoot) {
    ok = false;
    messages.push(`Claude local profile marketplace path is not current target: ${CLAUDE_LOCAL_PROFILE_MARKETPLACE}`);
  }

  for (const path of [
    join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
    join(marketplaceRoot, "plugins", pluginName, ".claude-plugin", "plugin.json"),
    join(marketplaceRoot, "plugins", pluginName, "skills"),
  ]) {
    if (!(await pathExists(path))) {
      ok = false;
      messages.push(`Missing Claude local profile plugin file: ${path}`);
    }
  }

  try {
    const pluginStatus = await getClaudeLocalProfilePluginStatus(targetRoot, pluginId, runner);
    if (!pluginStatus.installed) {
      ok = false;
      messages.push(`Claude local profile plugin is not installed: ${pluginId}`);
    } else if (!pluginStatus.enabled) {
      ok = false;
      messages.push(`Claude local profile plugin is installed but disabled: ${pluginId}`);
    }
  } catch (error) {
    ok = false;
    const message = error instanceof Error ? error.message : String(error);
    messages.push(`Unable to inspect Claude local profile plugin installation: ${message}`);
  }

  if (ok) {
    messages.push("Claude local profile plugin installed and enabled");
  }
  return ok;
}

async function checkPlatformDirectories(targetRoot: string, platform: Platform, messages: string[]): Promise<boolean> {
  let ok = true;

  for (const kind of ["skills", "hooks", "agents", "commands", "prompts"] as const) {
    const root = platformResourceRoot(platform, kind);
    if (!(await pathExists(join(targetRoot, root)))) {
      ok = false;
      messages.push(`Missing ${describePlatform(platform)} ${kind} directory: ${root}`);
    }
  }

  return ok;
}

async function checkPlatformHooks(targetRoot: string, platform: Platform, messages: string[]): Promise<boolean> {
  if (platform === "claude") {
    return checkClaudeHooks(targetRoot, messages);
  }
  return checkCopilotHooks(targetRoot, messages);
}

async function checkClaudeHooks(targetRoot: string, messages: string[]): Promise<boolean> {
  let ok = true;
  const hookFiles = [
    ".claude/hooks/session-start.py",
    ".claude/hooks/inject-workflow-state.py",
    ".claude/hooks/inject-subagent-context.py",
  ];

  for (const hookFile of hookFiles) {
    if (!(await pathExists(joinRelative(targetRoot, hookFile)))) {
      ok = false;
      messages.push(`Missing Claude hook file: ${hookFile}`);
    }
  }

  const settingsContent = await readTextFileIfExists(join(targetRoot, ".claude", "settings.json"));
  if (settingsContent === undefined) {
    messages.push("Missing Claude settings file: .claude/settings.json");
    return false;
  }

  try {
    const settings = JSON.parse(settingsContent) as unknown;
    const content = JSON.stringify(settings);
    for (const expectedCommand of [
      "python3 .claude/hooks/session-start.py",
      "python3 .claude/hooks/inject-workflow-state.py",
      "python3 .claude/hooks/inject-subagent-context.py",
    ]) {
      if (!content.includes(expectedCommand)) {
        ok = false;
        messages.push(`Claude settings does not register hook command: ${expectedCommand}`);
      }
    }
  } catch {
    ok = false;
    messages.push("Claude settings file is not valid JSON: .claude/settings.json");
  }

  if (ok) {
    messages.push("Claude hooks registered");
  }
  return ok;
}

async function checkCopilotHooks(targetRoot: string, messages: string[]): Promise<boolean> {
  let ok = true;
  const hookFiles = [".github/copilot/hooks/session-start.py", ".github/copilot/hooks/inject-workflow-state.py"];

  for (const hookFile of hookFiles) {
    if (!(await pathExists(joinRelative(targetRoot, hookFile)))) {
      ok = false;
      messages.push(`Missing Copilot hook file: ${hookFile}`);
    }
  }

  for (const configFile of [".github/copilot/hooks.json", ".github/hooks/ticiou.json"]) {
    const content = await readTextFileIfExists(joinRelative(targetRoot, configFile));
    if (content === undefined) {
      ok = false;
      messages.push(`Missing Copilot hooks config: ${configFile}`);
      continue;
    }

    try {
      JSON.parse(content);
    } catch {
      ok = false;
      messages.push(`Copilot hooks config is not valid JSON: ${configFile}`);
    }
  }

  if (ok) {
    messages.push("Copilot hooks registered");
  }
  return ok;
}

async function checkManifestFiles(targetRoot: string, messages: string[]): Promise<boolean> {
  const manifest = await readManifest(targetRoot);
  if (manifest.files.length === 0) {
    messages.push("No generated files recorded in manifest");
    return true;
  }

  let ok = true;
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    if (seen.has(entry.relativePath)) {
      ok = false;
      messages.push(`Duplicate manifest entry: ${entry.relativePath}`);
      continue;
    }
    seen.add(entry.relativePath);

    if (!(await pathExists(joinRelative(targetRoot, entry.relativePath)))) {
      ok = false;
      messages.push(`Missing generated file: ${entry.relativePath}`);
    }
  }

  if (ok) {
    messages.push("Manifest files verified");
  }
  return ok;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
