import { resolveTargetRoot } from "../../../infra/target-root.js";
import { getEnabledPlatforms } from "../../../project/config.js";
import { SkillHubClient } from "../../../skillhub/client.js";
import { resolveToken } from "../../../skillhub/credentials.js";
import { getSkillHubRuntimeConfig } from "../../../skillhub/selection.js";
import { syncSelectedSkills } from "../../../skillhub/sync.js";
import { useProfile } from "../profile/use.js";
import type { CommandResult } from "../types.js";
import { ensureProjectConfig, resolveProfileUser } from "./common.js";

export interface SyncSkillsOptions {
  cwd: string;
  user?: string;
  registry?: string;
  token?: string;
  askToken?: boolean;
  anonymous?: boolean;
  frozen?: boolean;
}

export async function syncSkills(options: SyncSkillsOptions): Promise<CommandResult> {
  const targetRoot = await resolveTargetRoot({ cwd: options.cwd });
  const config = await ensureProjectConfig(targetRoot);
  const user = await resolveProfileUser({ targetRoot, user: options.user, requireUser: true });
  const skillHubConfig = getSkillHubRuntimeConfig(config, user, options.registry);

  if (skillHubConfig.selections.length === 0) {
    return {
      targetRoot,
      messages: [`No SkillHub selections configured for profile ${user}`],
    };
  }

  const resolvedToken = await resolveToken({
    registry: skillHubConfig.registry,
    token: options.token,
    askToken: options.askToken,
    anonymous: options.anonymous,
    interactive: process.stdin.isTTY,
  });
  const syncResult = await syncSelectedSkills({
    targetRoot,
    profile: user,
    registry: skillHubConfig.registry,
    client: new SkillHubClient(skillHubConfig.registry, resolvedToken.token),
    selections: skillHubConfig.selections,
    platforms: getEnabledPlatforms(config),
    autoRefresh: true,
    frozen: options.frozen,
  });

  const useResult =
    options.frozen === true
      ? undefined
      : await useProfile({
          cwd: targetRoot,
          target: "cwd",
          user,
          registry: skillHubConfig.registry,
          token: options.token,
          askToken: options.askToken,
          anonymous: options.anonymous,
          frozen: true,
        });

  return {
    targetRoot,
    messages: [
      `Checked SkillHub selections for profile ${user}`,
      syncResult.changed ? "SkillHub lock updated" : "SkillHub skills already up to date",
      ...syncResult.messages,
      ...(useResult?.messages ?? []),
    ],
  };
}
