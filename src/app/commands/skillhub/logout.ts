import { resolveTargetRoot } from "../../../infra/target-root.js";
import { CredentialsStore } from "../../../skillhub/credentials.js";
import { normalizeRegistry } from "../../../skillhub/registry.js";
import type { CommandResult } from "../types.js";

export interface SkillHubLogoutOptions {
  cwd: string;
  registry?: string;
}

export async function logoutSkillHub(options: SkillHubLogoutOptions): Promise<CommandResult> {
  const targetRoot = await resolveTargetRoot({ cwd: options.cwd });
  const registry = normalizeRegistry(options.registry);
  await new CredentialsStore().deleteToken(registry);

  return {
    targetRoot,
    messages: [`Removed saved SkillHub token for ${registry}`],
  };
}
