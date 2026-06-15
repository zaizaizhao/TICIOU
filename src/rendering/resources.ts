import { readFile } from "node:fs/promises";
import { basename, extname, join, posix } from "node:path";

import { skillOutputDirectoryName, slugify } from "../domain/resource-names.js";
import type { ManagedSource, Platform, ResourceKind } from "../domain/types.js";
import { RESOURCE_KINDS } from "../domain/types.js";
import { listDirectoryNames, listFilesRecursive, pathExists } from "../infra/fs.js";
import type { ManagedFile } from "../infra/manifest.js";
import { resolveRuntimeProfilesDirectory } from "../infra/profile-paths.js";
import { platformResourceRoot } from "../platforms/registry.js";
import type { TiciouConfig } from "../project/config.js";
import { normalizeCommandFrontmatter, normalizeSkillFrontmatterName } from "./skill-frontmatter.js";

export async function collectManagedResourceFiles(
  targetRoot: string,
  user: string,
  config: TiciouConfig,
  platforms: Platform[],
): Promise<ManagedFile[]> {
  const files: ManagedFile[] = [];
  const profilesRoot = resolveRuntimeProfilesDirectory();

  for (const kind of RESOURCE_KINDS) {
    if (kind === "skills" && !config.render.legacyPackagedSkills) {
      continue;
    }

    files.push(
      ...(await collectResourceKindFiles({
        targetRoot,
        root: join(profilesRoot, "shared", kind),
        source: "shared",
        kind,
        prefix: config.render.prefix,
        platforms,
      })),
    );
    files.push(
      ...(await collectResourceKindFiles({
        targetRoot,
        root: join(profilesRoot, "users", user, kind),
        source: "profile",
        kind,
        prefix: config.render.prefix,
        user,
        platforms,
      })),
    );
  }

  return files;
}

interface CollectResourceKindFilesOptions {
  targetRoot: string;
  root: string;
  source: ManagedSource;
  kind: ResourceKind;
  prefix: string;
  user?: string;
  platforms: Platform[];
}

async function collectResourceKindFiles(options: CollectResourceKindFilesOptions): Promise<ManagedFile[]> {
  if (options.kind === "skills") {
    return collectSkillDirectoryFiles(options);
  }

  const resourceFiles = await listFilesRecursive(options.root);
  const files: ManagedFile[] = [];

  for (const resourceFile of resourceFiles) {
    const content = await readFile(join(options.root, ...resourceFile.split("/")), "utf8");
    const outputName = outputFileName({
      prefix: options.prefix,
      source: options.source,
      user: options.user,
      resourceFile,
    });
    const outputContent =
      options.kind === "commands"
        ? normalizeCommandFrontmatter(content, {
            name: basename(outputName, extname(outputName)),
            description: `Ticiou ${options.source === "shared" ? "shared" : "profile"} command: ${basename(
              resourceFile,
              extname(resourceFile),
            )}.`,
          })
        : content;

    for (const platform of options.platforms) {
      const platformRoot = platformResourceRoot(platform, options.kind);

      files.push({
        relativePath: posix.join(platformRoot, outputName),
        content: outputContent,
        kind: options.kind,
        platform,
        source: options.source,
      });
    }
  }

  return files;
}

async function collectSkillDirectoryFiles(options: CollectResourceKindFilesOptions): Promise<ManagedFile[]> {
  const skillNames = await listDirectoryNames(options.root);
  const files: ManagedFile[] = [];

  for (const skillName of skillNames) {
    const skillRoot = join(options.root, skillName);
    if (!(await pathExists(join(skillRoot, "SKILL.md")))) {
      continue;
    }

    const resourceFiles = await listFilesRecursive(skillRoot);
    const outputDirectoryName = skillOutputDirectoryName({
      prefix: options.prefix,
      source: options.source,
      user: options.user,
      skillName,
    });

    for (const resourceFile of resourceFiles) {
      const rawContent = await readFile(join(skillRoot, ...resourceFile.split("/")), "utf8");
      const content =
        resourceFile === "SKILL.md" ? normalizeSkillFrontmatterName(rawContent, outputDirectoryName) : rawContent;

      for (const platform of options.platforms) {
        if (platform === "claude" && options.source === "profile") {
          continue;
        }

        files.push({
          relativePath: posix.join(platformResourceRoot(platform, options.kind), outputDirectoryName, resourceFile),
          content,
          kind: options.kind,
          platform,
          source: options.source,
        });
      }
    }
  }

  return files;
}

function outputFileName(options: {
  prefix: string;
  source: ManagedSource;
  user?: string;
  resourceFile: string;
}): string {
  const parsedExtension = extname(options.resourceFile);
  const baseName = basename(options.resourceFile, parsedExtension);
  const stem =
    options.source === "shared"
      ? `${slugify(options.prefix)}-shared-${slugify(baseName)}`
      : `${slugify(options.prefix)}-user-${slugify(options.user ?? "unknown")}-${slugify(baseName)}`;

  return `${stem}${parsedExtension}`;
}
