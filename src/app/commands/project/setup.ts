import { resolveTargetRoot } from "../../../infra/target-root.js";
import { writeConfig } from "../../../project/config.js";
import { installPlatform } from "../platform/install.js";
import { useProfile } from "../profile/use.js";
import type { CommandMessage, CommandResult, SetupProjectOptions } from "../types.js";
import { initProject } from "./init.js";
import { SkillHubClient } from "../../../skillhub/client.js";
import { resolveToken } from "../../../skillhub/credentials.js";
import { normalizeRegistry } from "../../../skillhub/registry.js";
import { addSelection, ensureSkillHubProfileConfig } from "../../../skillhub/selection.js";
import type { DiscoverItem } from "../../../skillhub/types.js";
import { ensureConfig } from "../../../project/config.js";

export async function setupProject(
  options: SetupProjectOptions,
): Promise<CommandResult> {
  const targetRoot = await resolveTargetRoot({
    cwd: options.cwd,
    mode: options.target,
  });
  const messages: CommandMessage[] = [];

  const initResult = await initProject({ cwd: targetRoot, target: "cwd" });
  messages.push(...initResult.messages);

  for (const platform of options.platforms) {
    const installResult = await installPlatform({
      cwd: targetRoot,
      platform,
      target: "cwd",
    });
    messages.push(...installResult.messages);
  }

  if (options.user === undefined) {
    const skillHubSetup = await configureSkillHubProfile(targetRoot, options);
    messages.push(...skillHubSetup.messages);
    const useResult = await useProfile({
      cwd: targetRoot,
      user: skillHubSetup.user,
      target: "cwd",
      runner: options.runner,
      registry: skillHubSetup.registry,
      token: skillHubSetup.token,
    });
    messages.push(...useResult.messages);

    return {
      targetRoot,
      messages,
    };
  }

  const useResult = await useProfile({
    cwd: targetRoot,
    user: options.user,
    target: "cwd",
    runner: options.runner,
  });
  messages.push(...useResult.messages);

  return {
    targetRoot,
    messages,
  };
}

async function configureSkillHubProfile(
  targetRoot: string,
  options: SetupProjectOptions,
): Promise<{ user: string; registry: string; token?: string; messages: string[] }> {
  const registry = normalizeRegistry(options.registry);
  const resolvedToken = await resolveToken({
    registry,
    token: options.token,
    askToken: options.askToken ?? true,
    interactive: process.stdin.isTTY,
  });
  if (resolvedToken.token === undefined) {
    throw new Error("Ticiou setup requires a SkillHub token. Pass --token or run ticiou skillhub login first.");
  }

  const client = new SkillHubClient(registry, resolvedToken.token, options.fetchImpl);
  const whoami = await client.whoami();
  const discoverResult = await client.discover({
    owner: "self",
    page: 0,
    size: 100,
  });
  const selectedItems = await selectSetupSkills({
    user: whoami.handle,
    registry,
    items: discoverResult.items,
    selector: options.skillSelector,
    yes: options.yes,
  });

  const config = await ensureConfig(targetRoot);
  config.profiles.defaultUser = whoami.handle;
  const profileConfig = ensureSkillHubProfileConfig(config, whoami.handle, registry);
  profileConfig.selections = [];
  for (const item of selectedItems) {
    addSelection(profileConfig, {
      namespace: item.namespace,
      slug: item.slug,
      policy: "auto",
    });
  }
  await writeConfig(targetRoot, config);

  return {
    user: whoami.handle,
    registry,
    token: resolvedToken.token,
    messages: [
      `Authenticated SkillHub user ${whoami.handle}`,
      `Selected ${selectedItems.length} SkillHub ${selectedItems.length === 1 ? "skill" : "skills"}`,
    ],
  };
}

async function selectSetupSkills(options: {
  user: string;
  registry: string;
  items: DiscoverItem[];
  selector?: SetupProjectOptions["skillSelector"];
  yes?: boolean;
}): Promise<DiscoverItem[]> {
  if (options.selector !== undefined) {
    return options.selector({
      user: options.user,
      registry: options.registry,
      items: options.items,
    });
  }

  if (options.yes !== true && options.items.length > 0) {
    throw new Error("SkillHub setup requires skill selection. Run in an interactive terminal or pass --yes to enable all discovered skills.");
  }

  return options.items;
}
