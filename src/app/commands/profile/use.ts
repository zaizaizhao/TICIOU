import { writeManagedFiles } from "../../../infra/manifest.js";
import { resolveTargetRoot } from "../../../infra/target-root.js";
import { ensurePlatformInstalled } from "../../../platforms/registry.js";
import { getEnabledPlatforms, ensureConfig } from "../../../project/config.js";
import { ensurePackagedProfile, writeCurrentProfile } from "../../../project/profile-store.js";
import {
  collectClaudeLocalProfilePluginFiles,
  installClaudeLocalProfilePlugin,
  syncClaudeLocalProfilePluginSettings,
  uninstallClaudeLocalProfilePlugin,
} from "../../../rendering/claude-local-plugin.js";
import { collectManagedResourceFiles } from "../../../rendering/resources.js";
import { initProject } from "../project/init.js";
import type { CommandResult, UseProfileOptions } from "../types.js";

export async function useProfile(options: UseProfileOptions): Promise<CommandResult> {
  const targetRoot = await resolveTargetRoot({ cwd: options.cwd, mode: options.target });
  await initProject({ cwd: targetRoot, target: "cwd" });

  const config = await ensureConfig(targetRoot);
  await ensurePackagedProfile(options.user);

  const enabledPlatforms = getEnabledPlatforms(config);
  for (const platform of enabledPlatforms) {
    await ensurePlatformInstalled(targetRoot, platform);
  }

  const managedFiles = await collectManagedResourceFiles(targetRoot, options.user, config, enabledPlatforms);
  if (enabledPlatforms.includes("claude")) {
    managedFiles.push(...(await collectClaudeLocalProfilePluginFiles(options.user, config)));
  }

  await writeManagedFiles({
    targetRoot,
    files: managedFiles,
    removeStale: config.render.removeStale,
  });
  if (enabledPlatforms.includes("claude")) {
    await uninstallClaudeLocalProfilePlugin({
      targetRoot,
      config,
      runner: options.runner,
    });
    await syncClaudeLocalProfilePluginSettings(targetRoot, options.user, config);
    await installClaudeLocalProfilePlugin({
      targetRoot,
      user: options.user,
      config,
      runner: options.runner,
    });
  }
  await writeCurrentProfile(targetRoot, options.user);

  return {
    targetRoot,
    messages: [`Activated Ticiou profile ${options.user}`],
  };
}
