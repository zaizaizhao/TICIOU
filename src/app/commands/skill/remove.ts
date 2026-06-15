import { resolveTargetRoot } from "../../../infra/target-root.js";
import { writeConfig } from "../../../project/config.js";
import { parseSkillRef, removeSelection } from "../../../skillhub/selection.js";
import { useProfile } from "../profile/use.js";
import type { CommandResult } from "../types.js";
import { ensureProjectConfig, resolveProfileUser } from "./common.js";

export interface RemoveSkillOptions {
  cwd: string;
  user?: string;
  registry?: string;
  skillRef: string;
}

export async function removeSkill(options: RemoveSkillOptions): Promise<CommandResult> {
  const targetRoot = await resolveTargetRoot({ cwd: options.cwd });
  const config = await ensureProjectConfig(targetRoot);
  const user = await resolveProfileUser({ targetRoot, user: options.user, requireUser: true });
  const profileConfig = config.profiles.users[user]?.skillhub;
  const skill = parseSkillRef(options.skillRef);
  const removed = profileConfig === undefined ? false : removeSelection(profileConfig, skill.namespace, skill.slug);
  await writeConfig(targetRoot, config);

  const useResult = await useProfile({
    cwd: targetRoot,
    target: "cwd",
    user,
    registry: options.registry,
  });

  return {
    targetRoot,
    messages: [
      removed
        ? `Removed SkillHub selection ${skill.namespace}/${skill.slug} from profile ${user}`
        : `SkillHub selection ${skill.namespace}/${skill.slug} was not enabled for profile ${user}`,
      "Local SkillHub cache was kept",
      ...useResult.messages,
    ],
  };
}
