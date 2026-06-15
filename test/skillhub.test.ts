import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, test } from "vitest";

import { readConfig } from "../src/project/config.js";
import { SkillHubClient } from "../src/skillhub/client.js";
import { CredentialsStore, resolveToken } from "../src/skillhub/credentials.js";
import { collectSkillHubManagedFiles, ensureCachedSkill } from "../src/skillhub/install.js";
import { readSkillHubLock, writeSkillHubLock } from "../src/skillhub/lock.js";
import { normalizeRegistry } from "../src/skillhub/registry.js";
import { syncSelectedSkills } from "../src/skillhub/sync.js";
import type { ResolveResponse } from "../src/skillhub/types.js";

const tempRoots: string[] = [];

async function makeTempRoot(prefix = "ticiou-skillhub-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SkillHub registry and config", () => {
  test("normalizes registries and rejects unsupported protocols", () => {
    expect(normalizeRegistry(" http://localhost:3000/// ")).toBe("http://localhost:3000");
    expect(normalizeRegistry("https://skillhub.example.com/api?debug=1#frag")).toBe("https://skillhub.example.com/api");
    expect(() => normalizeRegistry("ftp://skillhub.example.com")).toThrow("Invalid SkillHub registry protocol");
  });

  test("reads nested SkillHub selections from YAML config", async () => {
    const root = await makeTempRoot();
    await mkdir(join(root, ".ticiou"), { recursive: true });
    await writeFile(
      join(root, ".ticiou/config.yaml"),
      [
        "version: 1",
        "project:",
        "  name: demo",
        "platforms:",
        "  claude:",
        "    enabled: true",
        "  copilot:",
        "    enabled: false",
        "target:",
        "  default: cwd",
        "profiles:",
        "  default_user: yanan.zhao",
        "  users:",
        "    yanan.zhao:",
        "      skillhub:",
        "        registry: http://localhost:3000///",
        "        auto_refresh: true",
        "        update_policy: auto",
        "        selections:",
        "          - namespace: emrois",
        "            slug: api-review",
        "            version: 1.2.0",
        "            policy: pinned",
        "render:",
        "  legacy_packaged_skills: false",
        "",
      ].join("\n"),
      "utf8",
    );

    const config = await readConfig(root);

    expect(config?.profiles.defaultUser).toBe("yanan.zhao");
    expect(config?.profiles.users["yanan.zhao"]?.skillhub?.registry).toBe("http://localhost:3000");
    expect(config?.profiles.users["yanan.zhao"]?.skillhub?.autoRefresh).toBe(true);
    expect(config?.profiles.users["yanan.zhao"]?.skillhub?.selections).toEqual([
      {
        namespace: "emrois",
        slug: "api-review",
        owner: undefined,
        ownerId: undefined,
        label: undefined,
        version: "1.2.0",
        policy: "pinned",
      },
    ]);
    expect(config?.render.legacyPackagedSkills).toBe(false);
  });

  test("rejects invalid SkillHub config values early", async () => {
    const root = await makeTempRoot();
    await mkdir(join(root, ".ticiou"), { recursive: true });
    await writeFile(
      join(root, ".ticiou/config.yaml"),
      [
        "version: 1",
        "project:",
        "  name: demo",
        "profiles:",
        "  users:",
        "    yanan.zhao:",
        "      skillhub:",
        "        registry: file:///tmp/skillhub",
        "        update_policy: sometimes",
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(readConfig(root)).rejects.toThrow("Invalid SkillHub registry protocol");
  });
});

describe("SkillHub credentials", () => {
  test("resolves tokens by flag, environment, store, prompt, then anonymous", async () => {
    const home = await makeTempRoot("ticiou-home-");
    await new CredentialsStore(home).setToken("http://localhost:3000", "stored-token", "yanan.zhao");

    await expect(
      resolveToken({
        registry: "http://localhost:3000",
        token: "flag-token",
        env: { SKILLHUB_TOKEN: "env-token" },
        home,
      }),
    ).resolves.toMatchObject({ token: "flag-token", source: "flag", persistent: false });
    await expect(
      resolveToken({
        registry: "http://localhost:3000",
        env: { SKILLHUB_TOKEN: "env-token" },
        home,
      }),
    ).resolves.toMatchObject({ token: "env-token", source: "env", persistent: false });
    await expect(
      resolveToken({
        registry: "http://localhost:3000",
        env: { SKILLHUB_TOKEN: "" },
        home,
      }),
    ).resolves.toMatchObject({ token: "stored-token", source: "ticiou-store", persistent: true });
    await expect(
      resolveToken({
        registry: "http://localhost:3001",
        env: { SKILLHUB_TOKEN: "" },
        home,
        anonymous: true,
      }),
    ).resolves.toMatchObject({ source: "anonymous", persistent: false });
  });

  test("writes credentials with owner-only permissions on POSIX systems", async () => {
    const home = await makeTempRoot("ticiou-home-");
    const store = new CredentialsStore(home);

    await store.setToken("http://localhost:3000", "stored-token");

    await expect(readFile(store.path, "utf8")).resolves.toContain("stored-token");
    if (process.platform !== "win32") {
      expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    }
  });
});

describe("SkillHub client", () => {
  test("adds bearer auth and unwraps API responses", async () => {
    let authorization: string | null = null;
    const fetchImpl: typeof fetch = async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization");
      return jsonResponse({ handle: "yanan.zhao", displayName: "Yanan Zhao" });
    };

    const response = await new SkillHubClient("http://localhost:3000", "secret-token", fetchImpl).whoami();

    expect(response.handle).toBe("yanan.zhao");
    expect(authorization).toBe("Bearer secret-token");
  });

  test("maps authentication failures without exposing tokens", async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ message: "nope" }, 401);

    await expect(new SkillHubClient("http://localhost:3000", "secret-token", fetchImpl).whoami()).rejects.toThrow(
      "SkillHub authentication failed",
    );
  });

  test("downloads normal responses and follows presigned redirects", async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
      if (url.includes("/api/cli/v1/")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example.com/demo.zip" },
        });
      }
      return new Response(new Uint8Array([1, 2, 3]));
    };

    const buffer = await new SkillHubClient("http://localhost:3000", "secret-token", fetchImpl).download(
      "global",
      "demo",
      "1.0.0",
    );

    expect([...new Uint8Array(buffer)]).toEqual([1, 2, 3]);
    expect(calls).toEqual([
      {
        url: "http://localhost:3000/api/cli/v1/skills/global/demo/versions/1.0.0/download",
        authorization: "Bearer secret-token",
      },
      {
        url: "https://cdn.example.com/demo.zip",
        authorization: null,
      },
    ]);
  });
});

describe("SkillHub lock, cache, and sync", () => {
  test("rejects locks from a different profile or registry", async () => {
    const root = await makeTempRoot();
    await writeSkillHubLock(root, {
      version: 1,
      profile: "yanan.zhao",
      registry: "http://localhost:3000",
      generatedAt: "",
      skills: [],
    });

    await expect(readSkillHubLock(root, "kaibin.xu", "http://localhost:3000")).rejects.toThrow(
      "SkillHub lock belongs to profile yanan.zhao",
    );
  });

  test("extracts cached skills and renders managed files for each enabled platform", async () => {
    const root = await makeTempRoot();
    const zip = zipSync({
      "SKILL.md": strToU8("# Demo Skill\n"),
      "notes/readme.md": strToU8("hello\n"),
    });
    const client = createSkillClient({
      resolve: {
        namespace: "global",
        slug: "demo",
        version: "1.0.0",
        versionId: 42,
        fingerprint: "sha256:abc",
        downloadUrl: "/download",
      },
      download: zip.buffer as ArrayBuffer,
    });

    const entry = await ensureCachedSkill({
      targetRoot: root,
      registry: "http://localhost:3000",
      client,
      namespace: "global",
      slug: "demo",
      platforms: ["claude", "copilot"],
    });
    const files = await collectSkillHubManagedFiles({
      targetRoot: root,
      registry: "http://localhost:3000",
      lockEntries: [entry],
      platforms: ["claude", "copilot"],
    });

    expect(entry.installTargets.map((target) => target.path)).toEqual([
      ".claude/skills/skillhub-global-demo",
      ".github/skills/skillhub-global-demo",
    ]);
    expect(files.map((file) => file.relativePath).sort()).toEqual([
      ".claude/skills/skillhub-global-demo/SKILL.md",
      ".claude/skills/skillhub-global-demo/notes/readme.md",
      ".github/skills/skillhub-global-demo/SKILL.md",
      ".github/skills/skillhub-global-demo/notes/readme.md",
    ].sort());
    expect(files.find((file) => file.relativePath.endsWith("SKILL.md"))?.content).toContain("name: skillhub-global-demo");
    expect(existsSync(join(root, ".ticiou/.runtime/skillhub-cache"))).toBe(true);
  });

  test("frozen sync checks remote state without writing lock or cache", async () => {
    const root = await makeTempRoot();
    let downloaded = false;
    const client = createSkillClient({
      resolve: {
        namespace: "global",
        slug: "demo",
        version: "1.0.0",
        versionId: 42,
        fingerprint: "sha256:abc",
        downloadUrl: "/download",
      },
      download: new ArrayBuffer(0),
      onDownload: () => {
        downloaded = true;
      },
    });

    const result = await syncSelectedSkills({
      targetRoot: root,
      profile: "yanan.zhao",
      registry: "http://localhost:3000",
      client,
      selections: [{ namespace: "global", slug: "demo", policy: "auto" }],
      platforms: ["claude"],
      autoRefresh: true,
      frozen: true,
    });

    expect(result.changed).toBe(false);
    expect(result.lock.skills).toEqual([]);
    expect(result.messages).toContain("SkillHub skill global/demo is not locked; frozen mode skipped install");
    expect(downloaded).toBe(false);
    expect(existsSync(join(root, ".ticiou/.runtime/skillhub-lock.json"))).toBe(false);
    expect(existsSync(join(root, ".ticiou/.runtime/skillhub-cache"))).toBe(false);
  });
});

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createSkillClient(options: {
  resolve: ResolveResponse;
  download: ArrayBuffer;
  onDownload?: () => void;
}): SkillHubClient {
  return {
    registry: "http://localhost:3000",
    token: undefined,
    whoami: async () => ({ handle: "yanan.zhao", displayName: "Yanan Zhao" }),
    search: async () => ({ items: [], total: 0, limit: 0 }),
    discover: async () => ({ items: [], total: 0, page: 0, size: 0 }),
    resolve: async () => options.resolve,
    download: async () => {
      options.onDownload?.();
      return options.download;
    },
  } as unknown as SkillHubClient;
}
