import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { clearResources, doctorProject, getStatus, initProject, installPlatform, useProfile } from "../src/app/commands/index.js";
import type { CommandRunResult, CommandRunner } from "../src/infra/command-runner.js";
import { getPowershellPythonCommand, getPythonCommand } from "../src/infra/python-command.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ticiou-commands-"));
  tempRoots.push(root);
  return root;
}

async function writeSkill(root: string, relativeDir: string, title: string): Promise<void> {
  const skillDir = join(root, relativeDir);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), `# ${title}\n`);
}

async function writeResource(root: string, relativePath: string, content: string): Promise<void> {
  const filePath = join(root, relativePath);
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, content);
}

function createFakeClaudeRunner(): { runner: CommandRunner; calls: Array<{ file: string; args: string[]; cwd: string }> } {
  const calls: Array<{ file: string; args: string[]; cwd: string }> = [];
  const installedPlugins = new Set<string>();

  const runner: CommandRunner = async (file, args, options): Promise<CommandRunResult> => {
    calls.push({ file, args, cwd: options.cwd });
    const command = args.join(" ");

    if (command.startsWith("plugin install ")) {
      const pluginId = args[2];
      if (pluginId !== undefined) {
        installedPlugins.add(pluginId);
      }
      return { stdout: "", stderr: "" };
    }

    if (command.startsWith("plugin uninstall ")) {
      const pluginId = args[2];
      if (pluginId !== undefined) {
        installedPlugins.delete(pluginId);
      }
      return { stdout: "", stderr: "" };
    }

    if (command === "plugin list --json") {
      return {
        stdout: `${JSON.stringify(
          [...installedPlugins].map((id) => ({
            id,
            scope: "local",
            enabled: true,
          })),
        )}\n`,
        stderr: "",
      };
    }

    return { stdout: "", stderr: "" };
  };

  return { runner, calls };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Ticiou command workflow", () => {
  test("initializes project state and keeps runtime files out of git", async () => {
    const root = await makeTempRoot();

    await initProject({ cwd: root });

    await expect(readFile(join(root, ".ticiou/config.yaml"), "utf8")).resolves.toContain("version: 1");
    await expect(readFile(join(root, ".gitignore"), "utf8")).resolves.toContain(".ticiou/");
    expect(existsSync(join(root, ".ticiou/shared"))).toBe(false);
    expect(existsSync(join(root, ".ticiou/profiles"))).toBe(false);
    expect(existsSync(join(root, ".ticiou/templates"))).toBe(false);
  });

  test("installs Claude and Copilot adapters and renders package shared plus active user skills", async () => {
    const root = await makeTempRoot();
    const { runner, calls } = createFakeClaudeRunner();

    await initProject({ cwd: root });
    await installPlatform({ cwd: root, platform: "claude" });
    await installPlatform({ cwd: root, platform: "copilot" });
    const claudeSettings = JSON.parse(await readFile(join(root, ".claude/settings.json"), "utf8")) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout?: number }> }>>;
    };
    expect(claudeSettings.hooks.SessionStart.map((entry) => entry.matcher)).toEqual(["startup", "clear", "compact"]);
    expect(claudeSettings.hooks.SessionStart[0]?.hooks[0]?.command).toBe(
      `${getPythonCommand()} .claude/hooks/session-start.py`,
    );
    expect(claudeSettings.hooks.UserPromptSubmit[0]?.hooks[0]).toMatchObject({
      command: `${getPythonCommand()} .claude/hooks/inject-workflow-state.py`,
      timeout: 15,
    });
    expect(existsSync(join(root, ".claude/hooks/session-start.py"))).toBe(true);
    expect(existsSync(join(root, ".claude/hooks/inject-workflow-state.py"))).toBe(true);
    expect(existsSync(join(root, ".claude/hooks/inject-subagent-context.py"))).toBe(true);
    await expect(readFile(join(root, ".github/copilot-instructions.md"), "utf8")).resolves.toContain("Ticiou");
    await expect(readFile(join(root, ".github/copilot/hooks/session-start.py"), "utf8")).resolves.toContain(
      "Ticiou SessionStart hook",
    );
    await expect(readFile(join(root, ".github/copilot/hooks.json"), "utf8")).resolves.toContain(
      `${getPythonCommand()} .github/copilot/hooks/session-start.py`,
    );
    await expect(readFile(join(root, ".github/copilot/hooks.json"), "utf8")).resolves.toContain(
      `${getPowershellPythonCommand()} .github/copilot/hooks/inject-workflow-state.py`,
    );
    await expect(readFile(join(root, ".github/hooks/ticiou.json"), "utf8")).resolves.toContain(
      `${getPythonCommand()} .github/copilot/hooks/inject-workflow-state.py`,
    );

    await useProfile({ cwd: root, user: "kaibin.xu", runner });

    await expect(readFile(join(root, ".claude/skills/ticiou-shared-azure-devops/SKILL.md"), "utf8")).resolves.toContain(
      "name: ticiou-shared-azure-devops",
    );
    expect(existsSync(join(root, ".claude/skills/ticiou-user-kaibin-xu-personal/SKILL.md"))).toBe(false);
    await expect(
      readFile(
        join(
          root,
          ".ticiou/.runtime/claude-plugin-marketplace/plugins/ticiou-kaibin-xu/skills/personal/SKILL.md",
        ),
        "utf8",
      ),
    ).resolves.toContain("name: personal");
    await expect(
      readFile(join(root, ".ticiou/.runtime/claude-plugin-marketplace/.claude-plugin/marketplace.json"), "utf8"),
    ).resolves.toContain("ticiou-kaibin-xu");
    const localSettings = JSON.parse(await readFile(join(root, ".claude/settings.local.json"), "utf8")) as {
      enabledPlugins: Record<string, boolean>;
      extraKnownMarketplaces: Record<string, { source: { source: string; path: string } }>;
    };
    expect(localSettings.enabledPlugins["ticiou-kaibin-xu@ticiou-local-profiles"]).toBe(true);
    expect(localSettings.extraKnownMarketplaces["ticiou-local-profiles"]?.source).toEqual({
      source: "directory",
      path: join(root, ".ticiou/.runtime/claude-plugin-marketplace"),
    });
    expect(calls.map((call) => call.args.join(" "))).toContain(
      `plugin marketplace add ${join(root, ".ticiou/.runtime/claude-plugin-marketplace")} --scope local`,
    );
    expect(calls.map((call) => call.args.join(" "))).toContain(
      "plugin install ticiou-kaibin-xu@ticiou-local-profiles --scope local",
    );
    await expect(readFile(join(root, ".github/skills/ticiou-shared-azure-devops/SKILL.md"), "utf8")).resolves.toContain(
      "# Azure DevOps Workflow",
    );
    await expect(
      readFile(join(root, ".github/skills/ticiou-user-kaibin-xu-personal/SKILL.md"), "utf8"),
    ).resolves.toContain("name: ticiou-user-kaibin-xu-personal");
    await expect(readFile(join(root, ".ticiou/.runtime/current-profile"), "utf8")).resolves.toBe("kaibin.xu\n");
    expect(existsSync(join(root, ".ticiou/profiles/kaibin.xu/profile.yaml"))).toBe(false);
  });

  test("switches the active user without leaving previous user resources or plugins active", async () => {
    const root = await makeTempRoot();
    const { runner, calls } = createFakeClaudeRunner();

    await initProject({ cwd: root });
    await installPlatform({ cwd: root, platform: "claude" });

    await useProfile({ cwd: root, user: "kaibin.xu", runner });
    await useProfile({ cwd: root, user: "yanan.zhao", runner });

    expect(existsSync(join(root, ".claude/skills/ticiou-user-kaibin-xu-personal/SKILL.md"))).toBe(false);
    expect(existsSync(join(root, ".claude/skills/ticiou-user-yanan-zhao-personal/SKILL.md"))).toBe(false);
    expect(existsSync(join(root, ".claude/skills/ticiou-shared-azure-devops/SKILL.md"))).toBe(true);
    expect(
      existsSync(
        join(root, ".ticiou/.runtime/claude-plugin-marketplace/plugins/ticiou-kaibin-xu/skills/personal/SKILL.md"),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(root, ".ticiou/.runtime/claude-plugin-marketplace/plugins/ticiou-kaibin-xu/skills/personal"),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(root, ".ticiou/.runtime/claude-plugin-marketplace/plugins/ticiou-yanan-zhao/skills/personal/SKILL.md"),
      ),
    ).toBe(true);
    const localSettings = JSON.parse(await readFile(join(root, ".claude/settings.local.json"), "utf8")) as {
      enabledPlugins: Record<string, boolean>;
    };
    expect(localSettings.enabledPlugins).toEqual({
      "ticiou-yanan-zhao@ticiou-local-profiles": true,
    });
    const pluginList = JSON.parse((await runner("claude", ["plugin", "list", "--json"], { cwd: root })).stdout) as Array<{
      id: string;
    }>;
    expect(pluginList.map((plugin) => plugin.id)).toEqual(["ticiou-yanan-zhao@ticiou-local-profiles"]);
    expect(calls.map((call) => call.args.join(" "))).toContain(
      "plugin uninstall ticiou-kaibin-xu@ticiou-local-profiles --scope local",
    );
  });

  test("clears active user resources while keeping shared resources rendered", async () => {
    const root = await makeTempRoot();
    const { runner, calls } = createFakeClaudeRunner();

    await initProject({ cwd: root });
    await installPlatform({ cwd: root, platform: "claude" });
    await useProfile({ cwd: root, user: "yanan.zhao", runner });

    const result = await clearResources({ cwd: root, scope: "user", runner });
    const status = await getStatus({ cwd: root });
    const manifest = JSON.parse(await readFile(join(root, ".ticiou/.runtime/manifest.json"), "utf8")) as {
      files: Array<{ relativePath: string; source: string }>;
    };

    expect(result.messages).toContain("Cleared user profile resources");
    expect(status.currentProfile).toBeUndefined();
    expect(existsSync(join(root, ".ticiou/.runtime/current-profile"))).toBe(false);
    expect(existsSync(join(root, ".claude/skills/ticiou-user-yanan-zhao-personal/SKILL.md"))).toBe(false);
    expect(existsSync(join(root, ".ticiou/.runtime/claude-plugin-marketplace/plugins/ticiou-yanan-zhao"))).toBe(
      false,
    );
    expect(existsSync(join(root, ".claude/settings.local.json"))).toBe(false);
    expect(existsSync(join(root, ".claude/skills/ticiou-shared-azure-devops/SKILL.md"))).toBe(true);
    expect(manifest.files.every((entry) => entry.source === "shared")).toBe(true);
    expect(calls.map((call) => call.args.join(" "))).toContain(
      "plugin uninstall ticiou-yanan-zhao@ticiou-local-profiles --scope local",
    );
  });

  test("clears all rendered Ticiou resources while keeping project config and platform templates", async () => {
    const root = await makeTempRoot();
    const { runner } = createFakeClaudeRunner();

    await initProject({ cwd: root });
    await installPlatform({ cwd: root, platform: "claude" });
    await useProfile({ cwd: root, user: "kaibin.xu", runner });

    const result = await clearResources({ cwd: root, scope: "all", runner });
    const status = await getStatus({ cwd: root });
    const manifest = JSON.parse(await readFile(join(root, ".ticiou/.runtime/manifest.json"), "utf8")) as {
      files: unknown[];
    };

    expect(result.messages).toContain("Cleared all rendered Ticiou resources");
    expect(status.currentProfile).toBeUndefined();
    expect(status.generatedFileCount).toBe(0);
    expect(manifest.files).toEqual([]);
    expect(existsSync(join(root, ".ticiou/config.yaml"))).toBe(true);
    expect(existsSync(join(root, ".claude/settings.json"))).toBe(true);
    expect(existsSync(join(root, ".claude/skills/ticiou-user-kaibin-xu-personal/SKILL.md"))).toBe(false);
    expect(existsSync(join(root, ".ticiou/.runtime/claude-plugin-marketplace"))).toBe(false);
    expect(existsSync(join(root, ".claude/settings.local.json"))).toBe(false);
    expect(existsSync(join(root, ".claude/skills/ticiou-shared-azure-devops/SKILL.md"))).toBe(false);
  });

  test("reports status and doctor warnings for the current target", async () => {
    const root = await makeTempRoot();
    const { runner } = createFakeClaudeRunner();

    await initProject({ cwd: root });
    await installPlatform({ cwd: root, platform: "claude" });
    await useProfile({ cwd: root, user: "kaibin.xu", runner });

    const status = await getStatus({ cwd: root });
    const doctor = await doctorProject({ cwd: root, runner });

    expect(status.targetRoot).toBe(root);
    expect(status.currentProfile).toBe("kaibin.xu");
    expect(status.enabledPlatforms).toEqual(["claude"]);
    expect(doctor.ok).toBe(true);
    expect(doctor.messages.join("\n")).toContain("Claude adapter installed");
    expect(doctor.messages.join("\n")).toContain("Manifest files verified");
    expect(doctor.messages.join("\n")).toContain("Claude hooks registered");
    expect(doctor.messages.join("\n")).toContain("Claude local profile plugin installed and enabled");
  });

  test("doctor reports when the Claude local plugin is configured but not installed", async () => {
    const root = await makeTempRoot();
    const runner: CommandRunner = async () => ({ stdout: "[]\n", stderr: "" });

    await initProject({ cwd: root });
    await installPlatform({ cwd: root, platform: "claude" });
    await useProfile({
      cwd: root,
      user: "yanan.zhao",
      runner: async (file, args, options) => {
        if (args.join(" ") === "plugin list --json") {
          return { stdout: "[]\n", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
    });

    const doctor = await doctorProject({ cwd: root, runner });

    expect(doctor.ok).toBe(false);
    expect(doctor.messages.join("\n")).toContain(
      "Claude local profile plugin is not installed: ticiou-yanan-zhao@ticiou-local-profiles",
    );
  });

  test("doctor reports missing hook files, stale manifest entries, and missing active profiles", async () => {
    const root = await makeTempRoot();
    const { runner } = createFakeClaudeRunner();

    await initProject({ cwd: root });
    await installPlatform({ cwd: root, platform: "claude" });
    await useProfile({ cwd: root, user: "kaibin.xu", runner });
    await rm(join(root, ".claude/hooks/session-start.py"), { force: true });
    await writeFile(join(root, ".ticiou/.runtime/current-profile"), "missing.user\n");
    const manifest = JSON.parse(await readFile(join(root, ".ticiou/.runtime/manifest.json"), "utf8")) as {
      files: Array<Record<string, string>>;
    };
    manifest.files.push({
      relativePath: ".claude/skills/ticiou-missing/SKILL.md",
      hash: "missing",
      kind: "skills",
      platform: "claude",
      source: "shared",
    });
    await writeFile(join(root, ".ticiou/.runtime/manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    const doctor = await doctorProject({ cwd: root, runner });

    expect(doctor.ok).toBe(false);
    expect(doctor.messages.join("\n")).toContain("Active profile missing.user was not found in packaged Ticiou profiles");
    expect(doctor.messages.join("\n")).toContain("Missing generated file: .claude/skills/ticiou-missing/SKILL.md");
    expect(doctor.messages.join("\n")).toContain("Missing Claude hook file: .claude/hooks/session-start.py");
  });

  test("renders hooks, subagents, commands, and prompts for Claude and Copilot", async () => {
    const root = await makeTempRoot();
    const { runner } = createFakeClaudeRunner();

    await initProject({ cwd: root });
    await installPlatform({ cwd: root, platform: "claude" });
    await installPlatform({ cwd: root, platform: "copilot" });

    await useProfile({ cwd: root, user: "kaibin.xu", runner });

    await expect(readFile(join(root, ".claude/hooks/ticiou-shared-session-start.py"), "utf8")).resolves.toBe(
      "print('shared hook')\n",
    );
    await expect(readFile(join(root, ".claude/agents/ticiou-user-kaibin-xu-domain.md"), "utf8")).resolves.toBe(
      "# Kaibin Domain Agent\n",
    );
    await expect(readFile(join(root, ".claude/commands/ticiou-shared-review.md"), "utf8")).resolves.toContain(
      "name: ticiou-shared-review\ndescription: Ticiou shared command: review.\ndisable-model-invocation: true",
    );
    await expect(readFile(join(root, ".claude/prompts/ticiou-user-kaibin-xu-tone.md"), "utf8")).resolves.toBe(
      "# Kaibin Tone Prompt\n",
    );
    await expect(readFile(join(root, ".github/hooks/ticiou-user-kaibin-xu-personal.py"), "utf8")).resolves.toBe(
      "print('personal hook')\n",
    );
    await expect(readFile(join(root, ".github/agents/ticiou-shared-reviewer.md"), "utf8")).resolves.toBe(
      "# Shared Reviewer\n",
    );
    await expect(readFile(join(root, ".github/prompts/ticiou-shared-security.md"), "utf8")).resolves.toBe(
      "# Shared Security Prompt\n",
    );
    await expect(readFile(join(root, ".github/commands/ticiou-user-kaibin-xu-ship.md"), "utf8")).resolves.toContain(
      "name: ticiou-user-kaibin-xu-ship\ndescription: Ticiou profile command: ship.\ndisable-model-invocation: true",
    );
  });

  test("fails when the requested user is not packaged with Ticiou", async () => {
    const root = await makeTempRoot();

    await initProject({ cwd: root });
    await installPlatform({ cwd: root, platform: "claude" });

    await expect(useProfile({ cwd: root, user: "missing.user" })).rejects.toThrow(
      "Profile missing.user was not found in packaged Ticiou profiles",
    );
  });
});
