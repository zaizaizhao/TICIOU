import { resolveTargetRoot } from "../../../infra/target-root.js";
import { SkillHubClient } from "../../../skillhub/client.js";
import { CredentialsStore, TerminalTokenPrompt } from "../../../skillhub/credentials.js";
import { normalizeRegistry } from "../../../skillhub/registry.js";
import type { CommandResult } from "../types.js";

export interface SkillHubLoginOptions {
  cwd: string;
  registry?: string;
  token?: string;
  save?: boolean;
}

export async function loginSkillHub(options: SkillHubLoginOptions): Promise<CommandResult> {
  const targetRoot = await resolveTargetRoot({ cwd: options.cwd });
  const registry = normalizeRegistry(options.registry);
  const token = options.token ?? process.env.SKILLHUB_TOKEN ?? (await readTokenInteractively(registry));
  if (token === undefined || token.length === 0) {
    throw new Error("SkillHub token is required.");
  }

  const client = new SkillHubClient(registry, token);
  const whoami = await client.whoami();

  if (options.save !== false) {
    await new CredentialsStore().setToken(registry, token, whoami.handle);
  }

  return {
    targetRoot,
    messages: [
      `Logged in to SkillHub ${registry} as ${whoami.handle}`,
      options.save === false ? "Token was used for verification only" : `Saved SkillHub token for ${registry}`,
    ],
  };
}

async function readTokenInteractively(registry: string): Promise<string | undefined> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error("SkillHub token is required in non-interactive mode. Pass --token or set SKILLHUB_TOKEN.");
  }

  return (await new TerminalTokenPrompt().askToken(registry)).token;
}
