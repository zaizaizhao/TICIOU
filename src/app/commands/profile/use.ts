import { writeManagedFiles } from "../../../infra/manifest.js";
import { resolveTargetRoot } from "../../../infra/target-root.js";
import { ensurePlatformInstalled } from "../../../platforms/registry.js";
import { getEnabledPlatforms, ensureConfig } from "../../../project/config.js";
import {
  ensurePackagedProfile,
  packagedProfileExists,
  writeCurrentProfile,
} from "../../../project/profile-store.js";
import {
  collectClaudeLocalProfilePluginFiles,
  installClaudeLocalProfilePlugin,
  syncClaudeLocalProfilePluginSettings,
  uninstallClaudeLocalProfilePlugin,
} from "../../../rendering/claude-local-plugin.js";
import { collectManagedResourceFiles } from "../../../rendering/resources.js";
import { SkillHubClient } from "../../../skillhub/client.js";
import { resolveToken } from "../../../skillhub/credentials.js";
import { collectSkillHubManagedFiles } from "../../../skillhub/install.js";
import { getSkillHubRuntimeConfig } from "../../../skillhub/selection.js";
import { syncSelectedSkills } from "../../../skillhub/sync.js";
import { initProject } from "../project/init.js";
import type { CommandResult, UseProfileOptions } from "../types.js";

export async function useProfile(
  options: UseProfileOptions,
): Promise<CommandResult> {
  const targetRoot = await resolveTargetRoot({
    cwd: options.cwd,
    mode: options.target,
  });
  await initProject({ cwd: targetRoot, target: "cwd" });

  const config = await ensureConfig(targetRoot);
  const hasPackagedProfile = await packagedProfileExists(options.user);
  const hasSkillHubProfile = config.profiles.users[options.user]?.skillhub !== undefined;
  if (!hasPackagedProfile && !hasSkillHubProfile) {
    await ensurePackagedProfile(options.user);
  }

  const enabledPlatforms = getEnabledPlatforms(config);
  for (const platform of enabledPlatforms) {
    await ensurePlatformInstalled(targetRoot, platform);
  }

  const managedFiles = await collectManagedResourceFiles(
    targetRoot,
    options.user,
    config,
    enabledPlatforms,
  );
  const messages: string[] = [];

  const skillHubConfig = getSkillHubRuntimeConfig(config, options.user, options.registry);
  if (skillHubConfig.selections.length > 0) {
    const resolvedToken = await resolveToken({
      registry: skillHubConfig.registry,
      token: options.token,
      askToken: options.askToken,
      anonymous: options.anonymous,
      interactive: process.stdin.isTTY,
    });
    const client = new SkillHubClient(skillHubConfig.registry, resolvedToken.token);

    if (resolvedToken.token !== undefined) {
      const whoami = await client.whoami();
      if (whoami.handle !== options.user) {
        messages.push(`SkillHub token user ${whoami.handle} differs from Ticiou profile ${options.user}`);
      }
    }

    const syncResult = await syncSelectedSkills({
      targetRoot,
      profile: options.user,
      registry: skillHubConfig.registry,
      client,
      selections: skillHubConfig.selections,
      platforms: enabledPlatforms,
      autoRefresh: skillHubConfig.autoRefresh,
      frozen: options.frozen,
    });
    messages.push(...syncResult.messages);
    managedFiles.push(
      ...(await collectSkillHubManagedFiles({
        targetRoot,
        registry: skillHubConfig.registry,
        lockEntries: syncResult.lock.skills,
        platforms: enabledPlatforms,
      })),
    );
  }

  let hasClaudePluginFiles = false;
  if (enabledPlatforms.includes("claude") && config.render.legacyPackagedSkills) {
    const pluginFiles = await collectClaudeLocalProfilePluginFiles(
      options.user,
      config,
    );
    hasClaudePluginFiles = pluginFiles.length > 0;
    managedFiles.push(...pluginFiles);
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
    await syncClaudeLocalProfilePluginSettings(
      targetRoot,
      hasClaudePluginFiles ? options.user : undefined,
      config,
    );
    if (hasClaudePluginFiles) {
      await installClaudeLocalProfilePlugin({
        targetRoot,
        user: options.user,
        config,
        runner: options.runner,
      });
    }
  }
  await writeCurrentProfile(targetRoot, options.user);

  return {
    targetRoot,
    messages: [...messages, `Activated Ticiou profile ${options.user}`],
  };
}
