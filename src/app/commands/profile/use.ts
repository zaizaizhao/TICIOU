import { writeManagedFiles } from "../../../infra/manifest.js";
import { resolveTargetRoot } from "../../../infra/target-root.js";
import { ensurePlatformInstalled } from "../../../platforms/registry.js";
import { getEnabledPlatforms, ensureConfig } from "../../../project/config.js";
import {
  ensurePackagedProfile,
  packagedProfileExists,
  writeCurrentProfile,
} from "../../../project/profile-store.js";
import { collectManagedResourceFiles } from "../../../rendering/resources.js";
import { SkillHubClient } from "../../../skillhub/client.js";
import { resolveToken } from "../../../skillhub/credentials.js";
import { collectSkillHubManagedFiles } from "../../../skillhub/install.js";
import { getSkillHubRuntimeConfig } from "../../../skillhub/selection.js";
import { syncSelectedSkills } from "../../../skillhub/sync.js";
import { initProject } from "../project/init.js";
import type { CommandMessage, CommandResult, UseProfileOptions } from "../types.js";

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
  const messages: CommandMessage[] = [];

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
      try {
        const whoami = await client.whoami();
        if (whoami.handle !== options.user) {
          messages.push({
            text: `SkillHub token user ${whoami.handle} differs from Ticiou profile ${options.user}`,
            tone: "warning",
          });
        }
      } catch (error) {
        messages.push({
          text: `SkillHub whoami check failed: ${error instanceof Error ? error.message : String(error)}`,
          tone: "warning",
        });
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

  await writeManagedFiles({
    targetRoot,
    files: managedFiles,
    removeStale: config.render.removeStale,
  });
  await writeCurrentProfile(targetRoot, options.user);

  return {
    targetRoot,
    messages: [...messages, `Activated Ticiou profile ${options.user}`],
  };
}
