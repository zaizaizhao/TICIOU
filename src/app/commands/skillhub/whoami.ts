import { resolveTargetRoot } from "../../../infra/target-root.js";
import { SkillHubClient } from "../../../skillhub/client.js";
import { resolveToken } from "../../../skillhub/credentials.js";
import { normalizeRegistry } from "../../../skillhub/registry.js";
import type { CommandResult } from "../types.js";

export interface SkillHubWhoAmIOptions {
  cwd: string;
  registry?: string;
  token?: string;
  askToken?: boolean;
  anonymous?: boolean;
}

export async function whoamiSkillHub(options: SkillHubWhoAmIOptions): Promise<CommandResult> {
  const targetRoot = await resolveTargetRoot({ cwd: options.cwd });
  const registry = normalizeRegistry(options.registry);
  const resolvedToken = await resolveToken({
    registry,
    token: options.token,
    askToken: options.askToken,
    anonymous: options.anonymous,
    interactive: process.stdin.isTTY,
  });

  if (resolvedToken.token === undefined) {
    return {
      targetRoot,
      messages: [`Registry: ${registry}`, "Token source: anonymous", "No SkillHub user authenticated"],
    };
  }

  const whoami = await new SkillHubClient(registry, resolvedToken.token).whoami();
  return {
    targetRoot,
    messages: [`Registry: ${registry}`, `Token source: ${resolvedToken.source}`, `User: ${whoami.handle}`],
  };
}
