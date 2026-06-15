import { resolveTargetRoot } from "../../../infra/target-root.js";
import { writeConfig } from "../../../project/config.js";
import type { SkillHubSelection } from "../../../project/config.js";
import { normalizeRegistry } from "../../../skillhub/registry.js";
import { addSelection, ensureSkillHubProfileConfig, parseSkillRef } from "../../../skillhub/selection.js";
import { useProfile } from "../profile/use.js";
import type { CommandResult } from "../types.js";
import { ensureProjectConfig, resolveProfileUser } from "./common.js";

export interface AddSkillOptions {
  cwd: string;
  user?: string;
  registry?: string;
  token?: string;
  askToken?: boolean;
  anonymous?: boolean;
  skillRef?: string;
  namespace?: string;
  owner?: string;
  ownerId?: string;
  label?: string;
  version?: string;
}

export async function addSkill(options: AddSkillOptions): Promise<CommandResult> {
  const targetRoot = await resolveTargetRoot({ cwd: options.cwd });
  const config = await ensureProjectConfig(targetRoot);
  const user = await resolveProfileUser({ targetRoot, user: options.user, requireUser: true });
  const registry = normalizeRegistry(options.registry ?? config.profiles.users[user]?.skillhub?.registry);
  const profileConfig = ensureSkillHubProfileConfig(config, user, registry);
  const selection = createSelection(options);
  const added = addSelection(profileConfig, selection);
  await writeConfig(targetRoot, config);

  const useResult = await useProfile({
    cwd: targetRoot,
    target: "cwd",
    user,
    registry,
    token: options.token,
    askToken: options.askToken,
    anonymous: options.anonymous,
  });

  return {
    targetRoot,
    messages: [
      added ? `Added SkillHub selection for profile ${user}` : `SkillHub selection already exists for profile ${user}`,
      ...useResult.messages,
    ],
  };
}

function createSelection(options: AddSkillOptions): SkillHubSelection {
  if (options.skillRef !== undefined) {
    const parsed = parseSkillRef(options.skillRef);
    return {
      namespace: parsed.namespace,
      slug: parsed.slug,
      version: options.version,
      policy: options.version === undefined ? "auto" : "pinned",
    };
  }

  if (options.namespace === undefined || options.namespace.length === 0) {
    throw new Error("SkillHub skill add requires <namespace>/<slug> or --namespace.");
  }

  return {
    namespace: options.namespace,
    owner: options.owner,
    ownerId: options.ownerId,
    label: options.label,
    policy: "prompt-new",
  };
}
