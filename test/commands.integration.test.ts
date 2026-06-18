import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, test } from "vitest";

import {
  addSkill,
  clearResources,
  doctorProject,
  getStatus,
  initProject,
  installPlatform,
  setupProject,
  useProfile,
} from "../src/app/commands/index.js";
import type { CommandRunResult, CommandRunner } from "../src/infra/command-runner.js";
import { getPowershellPythonCommand, getPythonCommand } from "../src/infra/python-command.js";
import { ensureConfig, writeConfig } from "../src/project/config.js";
import { writeSkillHubLock } from "../src/skillhub/lock.js";

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

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });
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

  test("sets up a new project platform and profile in one command without local user skills", async () => {
    const root = await makeTempRoot();

    const result = await setupProject({
      cwd: root,
      user: "kaibin.xu",
      platforms: ["copilot"],
    });
    const status = await getStatus({ cwd: root });

    expect(result.messages).toEqual([
      `Initialized Ticiou project at ${root}`,
      "Copilot adapter installed",
      "Activated Ticiou profile kaibin.xu",
    ]);
    expect(status.currentProfile).toBe("kaibin.xu");
    expect(status.enabledPlatforms).toEqual(["copilot"]);
    await expect(readFile(join(root, ".ticiou/.runtime/current-profile"), "utf8")).resolves.toBe("kaibin.xu\n");
    expect(existsSync(join(root, ".github/skills/ticiou-user-kaibin-xu-personal/SKILL.md"))).toBe(false);
    expect(existsSync(join(root, ".github/copilot-instructions.md"))).toBe(true);
  });

  test("sets up a new project from SkillHub token and selected remote skills", async () => {
    const root = await makeTempRoot();
    const zip = zipSync({
      "SKILL.md": strToU8("# Code Review\n"),
    });
    const fetchCalls: Array<{ url: string; authorization: string | null }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      fetchCalls.push({ url, authorization: new Headers(init?.headers).get("authorization") });

      if (url.endsWith("/api/cli/v1/auth/whoami")) {
        return jsonResponse({ handle: "yanan.zhao", displayName: "Yanan Zhao" });
      }
      if (url.includes("/api/cli/v1/skills/discover?")) {
        return jsonResponse({
          items: [
            {
              namespace: "global",
              slug: "code-review",
              displayName: "Code Review",
              summary: "Review pull requests",
              publishedVersion: "1.0.0",
            },
            {
              namespace: "global",
              slug: "security-check",
              displayName: "Security Check",
              summary: "Review security risks",
              publishedVersion: "1.0.0",
            },
          ],
          total: 2,
          page: 0,
          size: 100,
        });
      }
      if (url.endsWith("/api/cli/v1/skills/global/code-review/resolve")) {
        return jsonResponse({
          namespace: "global",
          slug: "code-review",
          version: "1.0.0",
          versionId: 10,
          fingerprint: "sha256:code",
          downloadUrl: "/download",
        });
      }
      if (url.endsWith("/api/cli/v1/skills/global/code-review/versions/1.0.0/download")) {
        return new Response(zip.buffer as ArrayBuffer);
      }
      return jsonResponse({ message: "not found" }, 404);
    };

    try {
      const result = await setupProject({
        cwd: root,
        platforms: ["claude"],
        token: "secret-token",
        skillSelector: async ({ items }) => [items[0]],
      });
      const status = await getStatus({ cwd: root });
      const config = await readFile(join(root, ".ticiou/config.yaml"), "utf8");

      expect(result.messages).toContain("Authenticated SkillHub user yanan.zhao");
      expect(result.messages).toContain("Selected 1 SkillHub skill");
      expect(result.messages).toContain("Installed SkillHub skill global/code-review@1.0.0");
      expect(result.messages).toContain("Activated Ticiou profile yanan.zhao");
      expect(status.currentProfile).toBe("yanan.zhao");
      expect(config).toContain("default_user: yanan.zhao");
      expect(config).toContain("slug: code-review");
      await expect(readFile(join(root, ".claude/skills/skillhub-global-code-review/SKILL.md"), "utf8")).resolves.toContain(
        "name: skillhub-global-code-review",
      );
      expect(existsSync(join(root, ".ticiou/.runtime/claude-plugin-marketplace"))).toBe(false);
      expect(existsSync(join(root, ".claude/settings.local.json"))).toBe(false);
      expect(fetchCalls.map((call) => call.authorization)).toContain("Bearer secret-token");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("renders binary assets from SkillHub packages without corrupting bytes", async () => {
    const root = await makeTempRoot();
    const logoBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x80, 0x41]);
    const zip = zipSync({
      "SKILL.md": strToU8("# Code Review\n"),
      "assets/logo.png": logoBytes,
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cli/v1/auth/whoami")) {
        return jsonResponse({ handle: "yanan.zhao", displayName: "Yanan Zhao" });
      }
      if (url.includes("/api/cli/v1/skills/discover?")) {
        return jsonResponse({
          items: [{ namespace: "global", slug: "code-review", publishedVersion: "1.0.0" }],
          total: 1,
          page: 0,
          size: 100,
        });
      }
      if (url.endsWith("/api/cli/v1/skills/global/code-review/resolve")) {
        return jsonResponse({
          namespace: "global",
          slug: "code-review",
          version: "1.0.0",
          versionId: 10,
          fingerprint: "sha256:code",
          downloadUrl: "/download",
        });
      }
      if (url.endsWith("/api/cli/v1/skills/global/code-review/versions/1.0.0/download")) {
        return new Response(zip.buffer as ArrayBuffer);
      }
      return jsonResponse({ message: "not found" }, 404);
    };

    try {
      await setupProject({
        cwd: root,
        platforms: ["claude"],
        token: "secret-token",
        skillSelector: async ({ items }) => [items[0]],
      });

      await expect(readFile(join(root, ".claude/skills/skillhub-global-code-review/assets/logo.png"))).resolves.toEqual(
        Buffer.from(logoBytes),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("requires explicit selection for non-interactive SkillHub setup", async () => {
    const root = await makeTempRoot();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cli/v1/auth/whoami")) {
        return jsonResponse({ handle: "yanan.zhao", displayName: "Yanan Zhao" });
      }
      if (url.includes("/api/cli/v1/skills/discover?")) {
        return jsonResponse({
          items: [{ namespace: "global", slug: "code-review", publishedVersion: "1.0.0" }],
          total: 1,
          page: 0,
          size: 100,
        });
      }
      return jsonResponse({ message: "not found" }, 404);
    };

    try {
      await expect(
        setupProject({
          cwd: root,
          platforms: ["claude"],
          token: "secret-token",
        }),
      ).rejects.toThrow("SkillHub setup requires skill selection");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("sets up multiple platforms in one command", async () => {
    const root = await makeTempRoot();
    const { runner, calls } = createFakeClaudeRunner();

    const result = await setupProject({
      cwd: root,
      user: "kaibin.xu",
      platforms: ["claude", "copilot"],
      runner,
    });
    const status = await getStatus({ cwd: root });

    expect(result.messages).toEqual([
      `Initialized Ticiou project at ${root}`,
      "Claude adapter installed",
      "Copilot adapter installed",
      "Activated Ticiou profile kaibin.xu",
    ]);
    expect(status.enabledPlatforms).toEqual(["claude", "copilot"]);
    expect(calls.some((call) => call.args[0] === "plugin")).toBe(false);
    expect(existsSync(join(root, ".claude/settings.json"))).toBe(true);
    expect(existsSync(join(root, ".github/copilot-instructions.md"))).toBe(true);
  });

  test("installs Claude and Copilot adapters and renders packaged non-skill resources", async () => {
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
    expect(existsSync(join(root, ".ticiou/.runtime/claude-plugin-marketplace"))).toBe(false);
    expect(existsSync(join(root, ".claude/settings.local.json"))).toBe(false);
    expect(calls.some((call) => call.args[0] === "plugin")).toBe(false);
    await expect(readFile(join(root, ".github/skills/ticiou-shared-azure-devops/SKILL.md"), "utf8")).resolves.toContain(
      "# Azure DevOps Workflow",
    );
    expect(existsSync(join(root, ".github/skills/ticiou-user-kaibin-xu-personal/SKILL.md"))).toBe(false);
    await expect(readFile(join(root, ".ticiou/.runtime/current-profile"), "utf8")).resolves.toBe("kaibin.xu\n");
    expect(existsSync(join(root, ".ticiou/profiles/kaibin.xu/profile.yaml"))).toBe(false);
  });

  test("switches the active user without leaving previous user resources active", async () => {
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
    ).toBe(false);
    expect(existsSync(join(root, ".claude/settings.local.json"))).toBe(false);
    const pluginList = JSON.parse((await runner("claude", ["plugin", "list", "--json"], { cwd: root })).stdout) as Array<{
      id: string;
    }>;
    expect(pluginList.map((plugin) => plugin.id)).toEqual([]);
    expect(calls.some((call) => call.args[0] === "plugin" && call.args[1] !== "list")).toBe(false);
  });

  test("switches users when both profiles have SkillHub selections", async () => {
    const root = await makeTempRoot();
    const { runner } = createFakeClaudeRunner();
    const zipBySlug = new Map([
      ["kaibin-skill", zipSync({ "SKILL.md": strToU8("# Kaibin Skill\n") }).buffer as ArrayBuffer],
      ["yanan-skill", zipSync({ "SKILL.md": strToU8("# Yanan Skill\n") }).buffer as ArrayBuffer],
    ]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cli/v1/auth/whoami")) {
        return jsonResponse({ handle: "token.user", displayName: "Token User" });
      }
      for (const slug of zipBySlug.keys()) {
        if (url.endsWith(`/api/cli/v1/skills/global/${slug}/resolve`)) {
          return jsonResponse({
            namespace: "global",
            slug,
            version: "1.0.0",
            versionId: slug === "kaibin-skill" ? 10 : 20,
            fingerprint: `sha256:${slug}`,
            downloadUrl: "/download",
          });
        }
        if (url.endsWith(`/api/cli/v1/skills/global/${slug}/versions/1.0.0/download`)) {
          return new Response(zipBySlug.get(slug));
        }
      }
      return jsonResponse({ message: "not found" }, 404);
    };

    try {
      await initProject({ cwd: root });
      await installPlatform({ cwd: root, platform: "claude" });
      const config = await ensureConfig(root);
      config.profiles.users["kaibin.xu"] = {
        skillhub: {
          registry: "http://localhost:3000",
          autoRefresh: false,
          backgroundCheck: true,
          updatePolicy: "prompt",
          newSkillPolicy: "prompt",
          deletedSkillPolicy: "keep-cache",
          selections: [{ namespace: "global", slug: "kaibin-skill", policy: "auto" }],
        },
      };
      config.profiles.users["yanan.zhao"] = {
        skillhub: {
          registry: "http://localhost:3000",
          autoRefresh: false,
          backgroundCheck: true,
          updatePolicy: "prompt",
          newSkillPolicy: "prompt",
          deletedSkillPolicy: "keep-cache",
          selections: [{ namespace: "global", slug: "yanan-skill", policy: "auto" }],
        },
      };
      await writeConfig(root, config);

      await useProfile({ cwd: root, user: "kaibin.xu", runner, token: "secret-token" });
      await useProfile({ cwd: root, user: "yanan.zhao", runner, token: "secret-token" });

      expect(existsSync(join(root, ".claude/skills/skillhub-global-kaibin-skill/SKILL.md"))).toBe(false);
      await expect(readFile(join(root, ".claude/skills/skillhub-global-yanan-skill/SKILL.md"), "utf8")).resolves.toContain(
        "name: skillhub-global-yanan-skill",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("adds selector selections and renders discovered SkillHub skills", async () => {
    const root = await makeTempRoot();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cli/v1/auth/whoami")) {
        return jsonResponse({ handle: "yanan.zhao", displayName: "Yanan Zhao" });
      }
      if (url.includes("/api/cli/v1/skills/discover?")) {
        expect(url).toContain("namespace=emrois");
        expect(url).toContain("owner=self");
        expect(url).toContain("label=active");
        return jsonResponse({
          items: [
            { namespace: "emrois", slug: "api-review", publishedVersion: "1.0.0" },
            { namespace: "emrois", slug: "security-review", publishedVersion: "1.1.0" },
          ],
          total: 2,
          page: 0,
          size: 100,
        });
      }
      if (url.endsWith("/api/cli/v1/skills/emrois/api-review/resolve?version=1.0.0")) {
        return jsonResponse({
          namespace: "emrois",
          slug: "api-review",
          version: "1.0.0",
          versionId: 10,
          fingerprint: "sha256:api-review",
          downloadUrl: "/download",
        });
      }
      if (url.endsWith("/api/cli/v1/skills/emrois/security-review/resolve?version=1.1.0")) {
        return jsonResponse({
          namespace: "emrois",
          slug: "security-review",
          version: "1.1.0",
          versionId: 11,
          fingerprint: "sha256:security-review",
          downloadUrl: "/download",
        });
      }
      if (url.endsWith("/api/cli/v1/skills/emrois/api-review/versions/1.0.0/download")) {
        return new Response(zipSync({ "SKILL.md": strToU8("# API Review\n") }).buffer as ArrayBuffer);
      }
      if (url.endsWith("/api/cli/v1/skills/emrois/security-review/versions/1.1.0/download")) {
        return new Response(zipSync({ "SKILL.md": strToU8("# Security Review\n") }).buffer as ArrayBuffer);
      }
      return jsonResponse({ message: "not found" }, 404);
    };

    try {
      await initProject({ cwd: root });
      await installPlatform({ cwd: root, platform: "claude" });
      const config = await ensureConfig(root);
      config.profiles.defaultUser = "yanan.zhao";
      await writeConfig(root, config);

      const result = await addSkill({
        cwd: root,
        namespace: "emrois",
        owner: "self",
        label: "active",
        token: "secret-token",
      });

      expect(result.messages).toContain("Added SkillHub selection for profile yanan.zhao");
      expect(result.messages).toContain("Installed SkillHub skill emrois/api-review@1.0.0");
      expect(result.messages).toContain("Installed SkillHub skill emrois/security-review@1.1.0");
      await expect(readFile(join(root, ".claude/skills/skillhub-emrois-api-review/SKILL.md"), "utf8")).resolves.toContain(
        "name: skillhub-emrois-api-review",
      );
      await expect(
        readFile(join(root, ".claude/skills/skillhub-emrois-security-review/SKILL.md"), "utf8"),
      ).resolves.toContain("name: skillhub-emrois-security-review");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("removes rendered SkillHub files when a selected skill becomes forbidden", async () => {
    const root = await makeTempRoot();
    let remoteStatus: "ok" | "forbidden" = "ok";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cli/v1/auth/whoami")) {
        return jsonResponse({ handle: "yanan.zhao", displayName: "Yanan Zhao" });
      }
      if (url.endsWith("/api/cli/v1/skills/global/code-review/resolve")) {
        if (remoteStatus === "forbidden") {
          return jsonResponse({ message: "forbidden" }, 403);
        }
        return jsonResponse({
          namespace: "global",
          slug: "code-review",
          version: "1.0.0",
          versionId: 10,
          fingerprint: "sha256:code-review",
          downloadUrl: "/download",
        });
      }
      if (url.endsWith("/api/cli/v1/skills/global/code-review/versions/1.0.0/download")) {
        return new Response(zipSync({ "SKILL.md": strToU8("# Code Review\n") }).buffer as ArrayBuffer);
      }
      return jsonResponse({ message: "not found" }, 404);
    };

    try {
      await initProject({ cwd: root });
      await installPlatform({ cwd: root, platform: "claude" });
      const config = await ensureConfig(root);
      config.profiles.users["yanan.zhao"] = {
        skillhub: {
          registry: "http://localhost:3000",
          autoRefresh: true,
          backgroundCheck: true,
          updatePolicy: "prompt",
          newSkillPolicy: "prompt",
          deletedSkillPolicy: "keep-cache",
          selections: [{ namespace: "global", slug: "code-review", policy: "auto" }],
        },
      };
      await writeConfig(root, config);

      await useProfile({ cwd: root, user: "yanan.zhao", token: "secret-token" });
      expect(existsSync(join(root, ".claude/skills/skillhub-global-code-review/SKILL.md"))).toBe(true);

      remoteStatus = "forbidden";
      await useProfile({ cwd: root, user: "yanan.zhao", token: "secret-token" });

      expect(existsSync(join(root, ".claude/skills/skillhub-global-code-review/SKILL.md"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("removes rendered SkillHub files when a selected skill is missing from the registry", async () => {
    const root = await makeTempRoot();
    let remoteStatus: "ok" | "missing" = "ok";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cli/v1/auth/whoami")) {
        return jsonResponse({ handle: "yanan.zhao", displayName: "Yanan Zhao" });
      }
      if (url.endsWith("/api/cli/v1/skills/global/code-review/resolve")) {
        if (remoteStatus === "missing") {
          return jsonResponse({ message: "not found" }, 404);
        }
        return jsonResponse({
          namespace: "global",
          slug: "code-review",
          version: "1.0.0",
          versionId: 10,
          fingerprint: "sha256:code-review",
          downloadUrl: "/download",
        });
      }
      if (url.endsWith("/api/cli/v1/skills/global/code-review/versions/1.0.0/download")) {
        return new Response(zipSync({ "SKILL.md": strToU8("# Code Review\n") }).buffer as ArrayBuffer);
      }
      return jsonResponse({ message: "not found" }, 404);
    };

    try {
      await initProject({ cwd: root });
      await installPlatform({ cwd: root, platform: "claude" });
      const config = await ensureConfig(root);
      config.profiles.users["yanan.zhao"] = {
        skillhub: {
          registry: "http://localhost:3000",
          autoRefresh: true,
          backgroundCheck: true,
          updatePolicy: "prompt",
          newSkillPolicy: "prompt",
          deletedSkillPolicy: "keep-cache",
          selections: [{ namespace: "global", slug: "code-review", policy: "auto" }],
        },
      };
      await writeConfig(root, config);

      await useProfile({ cwd: root, user: "yanan.zhao", token: "secret-token" });
      expect(existsSync(join(root, ".claude/skills/skillhub-global-code-review/SKILL.md"))).toBe(true);

      remoteStatus = "missing";
      await useProfile({ cwd: root, user: "yanan.zhao", token: "secret-token" });

      expect(existsSync(join(root, ".claude/skills/skillhub-global-code-review/SKILL.md"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("continues rendering when SkillHub whoami soft validation fails", async () => {
    const root = await makeTempRoot();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/api/cli/v1/auth/whoami")) {
        return jsonResponse({ message: "unauthorized" }, 401);
      }
      if (url.endsWith("/api/cli/v1/skills/global/code-review/resolve")) {
        return jsonResponse({
          namespace: "global",
          slug: "code-review",
          version: "1.0.0",
          versionId: 10,
          fingerprint: "sha256:code-review",
          downloadUrl: "/download",
        });
      }
      if (url.endsWith("/api/cli/v1/skills/global/code-review/versions/1.0.0/download")) {
        return new Response(zipSync({ "SKILL.md": strToU8("# Code Review\n") }).buffer as ArrayBuffer);
      }
      return jsonResponse({ message: "not found" }, 404);
    };

    try {
      await initProject({ cwd: root });
      await installPlatform({ cwd: root, platform: "claude" });
      const config = await ensureConfig(root);
      config.profiles.users["yanan.zhao"] = {
        skillhub: {
          registry: "http://localhost:3000",
          autoRefresh: false,
          backgroundCheck: true,
          updatePolicy: "prompt",
          newSkillPolicy: "prompt",
          deletedSkillPolicy: "keep-cache",
          selections: [{ namespace: "global", slug: "code-review", policy: "auto" }],
        },
      };
      await writeConfig(root, config);

      const result = await useProfile({ cwd: root, user: "yanan.zhao", token: "expired-token" });

      expect(result.messages).toContainEqual({
        text: "SkillHub whoami check failed: SkillHub authentication failed.",
        tone: "warning",
      });
      await expect(readFile(join(root, ".claude/skills/skillhub-global-code-review/SKILL.md"), "utf8")).resolves.toContain(
        "name: skillhub-global-code-review",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses locked cache when SkillHub registry is unreachable", async () => {
    const root = await makeTempRoot();
    let online = true;
    const renderedSkillPath = join(root, ".claude/skills/skillhub-global-code-review/SKILL.md");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      if (!online) {
        throw new TypeError("fetch failed");
      }
      const url = String(input);
      if (url.endsWith("/api/cli/v1/auth/whoami")) {
        return jsonResponse({ handle: "yanan.zhao", displayName: "Yanan Zhao" });
      }
      if (url.endsWith("/api/cli/v1/skills/global/code-review/resolve")) {
        return jsonResponse({
          namespace: "global",
          slug: "code-review",
          version: "1.0.0",
          versionId: 10,
          fingerprint: "sha256:code-review",
          downloadUrl: "/download",
        });
      }
      if (url.endsWith("/api/cli/v1/skills/global/code-review/versions/1.0.0/download")) {
        return new Response(zipSync({ "SKILL.md": strToU8("# Code Review\n") }).buffer as ArrayBuffer);
      }
      return jsonResponse({ message: "not found" }, 404);
    };

    try {
      await initProject({ cwd: root });
      await installPlatform({ cwd: root, platform: "claude" });
      const config = await ensureConfig(root);
      config.profiles.users["yanan.zhao"] = {
        skillhub: {
          registry: "http://localhost:3000",
          autoRefresh: true,
          backgroundCheck: true,
          updatePolicy: "prompt",
          newSkillPolicy: "prompt",
          deletedSkillPolicy: "keep-cache",
          selections: [{ namespace: "global", slug: "code-review", policy: "auto" }],
        },
      };
      await writeConfig(root, config);

      await useProfile({ cwd: root, user: "yanan.zhao", token: "secret-token" });
      expect(existsSync(renderedSkillPath)).toBe(true);
      await rm(renderedSkillPath, { force: true });
      expect(existsSync(renderedSkillPath)).toBe(false);

      online = false;
      const result = await useProfile({ cwd: root, user: "yanan.zhao", token: "secret-token" });

      expect(result.messages).toContainEqual({
        text: "SkillHub registry unreachable; using cached global/code-review@1.0.0",
        tone: "warning",
      });
      await expect(readFile(renderedSkillPath, "utf8")).resolves.toContain("name: skillhub-global-code-review");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fails when SkillHub registry is unreachable without a locked cache", async () => {
    const root = await makeTempRoot();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };

    try {
      await initProject({ cwd: root });
      await installPlatform({ cwd: root, platform: "claude" });
      const config = await ensureConfig(root);
      config.profiles.users["yanan.zhao"] = {
        skillhub: {
          registry: "http://localhost:3000",
          autoRefresh: true,
          backgroundCheck: true,
          updatePolicy: "prompt",
          newSkillPolicy: "prompt",
          deletedSkillPolicy: "keep-cache",
          selections: [{ namespace: "global", slug: "code-review", policy: "auto" }],
        },
      };
      await writeConfig(root, config);

      await expect(useProfile({ cwd: root, user: "yanan.zhao", token: "secret-token" })).rejects.toThrow(
        "SkillHub registry unreachable.",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
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
    expect(calls.some((call) => call.args[0] === "plugin")).toBe(false);
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

  test("clears SkillHub locks when clearing all rendered resources", async () => {
    const root = await makeTempRoot();

    await initProject({ cwd: root });
    await writeSkillHubLock(root, {
      version: 1,
      profile: "kaibin.xu",
      registry: "http://localhost:3000",
      generatedAt: "",
      skills: [],
    });
    await writeSkillHubLock(root, {
      version: 1,
      profile: "yanan.zhao",
      registry: "http://localhost:3000",
      generatedAt: "",
      skills: [],
    });

    await clearResources({ cwd: root, scope: "all" });

    expect(existsSync(join(root, ".ticiou/.runtime/skillhub-locks"))).toBe(false);
    expect(existsSync(join(root, ".ticiou/.runtime/skillhub-lock.json"))).toBe(false);
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
  });

  test("doctor does not require the deprecated Claude local profile plugin", async () => {
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

    expect(doctor.ok).toBe(true);
    expect(doctor.messages.join("\n")).not.toContain("Claude local profile plugin");
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
    expect(doctor.messages.join("\n")).toContain("Active profile: missing.user");
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
