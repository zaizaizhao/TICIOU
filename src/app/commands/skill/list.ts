import { resolveTargetRoot } from "../../../infra/target-root.js";
import { SkillHubClient } from "../../../skillhub/client.js";
import { resolveToken } from "../../../skillhub/credentials.js";
import { getSkillHubRuntimeConfig } from "../../../skillhub/selection.js";
import { SkillHubError } from "../../../skillhub/types.js";
import type { DiscoverItem } from "../../../skillhub/types.js";
import type { CommandResult } from "../types.js";
import { ensureProjectConfig, resolveProfileUser } from "./common.js";

export interface ListSkillsOptions {
  cwd: string;
  user?: string;
  registry?: string;
  token?: string;
  askToken?: boolean;
  anonymous?: boolean;
  remote?: boolean;
  namespace?: string;
  owner?: string;
  label?: string;
  q?: string;
}

export async function listSkills(options: ListSkillsOptions): Promise<CommandResult> {
  const targetRoot = await resolveTargetRoot({ cwd: options.cwd });
  const config = await ensureProjectConfig(targetRoot);
  const user = await resolveProfileUser({ targetRoot, user: options.user, requireUser: false });
  const skillHubConfig = getSkillHubRuntimeConfig(config, user, options.registry);
  const resolvedToken = await resolveToken({
    registry: skillHubConfig.registry,
    token: options.token,
    askToken: options.askToken,
    anonymous: options.anonymous,
    interactive: process.stdin.isTTY,
  });
  const client = new SkillHubClient(skillHubConfig.registry, resolvedToken.token);

  const items = await discoverOrSearch(client, {
    q: options.q,
    namespace: options.namespace,
    owner: options.owner,
    label: options.label,
  });

  return {
    targetRoot,
    messages: [
      `Registry: ${skillHubConfig.registry}`,
      `Token source: ${resolvedToken.source}`,
      ...formatItems(items),
    ],
  };
}

async function discoverOrSearch(
  client: SkillHubClient,
  query: { q?: string; namespace?: string; owner?: string; label?: string },
): Promise<DiscoverItem[]> {
  try {
    const result = await client.discover({
      q: query.q,
      namespace: query.namespace,
      owner: query.owner,
      label: query.label,
      page: 0,
      size: 100,
    });
    return result.items;
  } catch (error) {
    if (error instanceof SkillHubError && error.status === 404) {
      const result = await client.search(query.q ?? "", 100);
      return result.items
        .filter((item) => query.namespace === undefined || item.namespace === query.namespace)
        .map((item) => ({
          namespace: item.namespace,
          slug: item.slug,
          publishedVersion: item.latestVersion,
          summary: item.summary,
        }));
    }
    throw error;
  }
}

function formatItems(items: DiscoverItem[]): string[] {
  if (items.length === 0) {
    return ["No remote SkillHub skills found"];
  }

  return items.map((item) => {
    const version = item.publishedVersion ?? "-";
    const visibility = item.visibility ?? "-";
    const summary = item.summary === undefined || item.summary.length === 0 ? "" : ` - ${item.summary}`;
    return `${item.namespace}/${item.slug}@${version} ${visibility}${summary}`;
  });
}
