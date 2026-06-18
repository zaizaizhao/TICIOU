import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, test } from "vitest";

import { readConfig } from "../src/project/config.js";
import { SkillHubClient } from "../src/skillhub/client.js";
import { CredentialsStore, resolveToken, TerminalTokenPrompt } from "../src/skillhub/credentials.js";
import { collectSkillHubManagedFiles, ensureCachedSkill, hasCachedSkill } from "../src/skillhub/install.js";
import { readSkillHubLock, writeSkillHubLock } from "../src/skillhub/lock.js";
import { normalizeRegistry } from "../src/skillhub/registry.js";
import { syncSelectedSkills } from "../src/skillhub/sync.js";
import { SkillHubError, type ResolveResponse } from "../src/skillhub/types.js";

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

  test("terminal token prompt reads token and save confirmation from one input stream", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let outputText = "";
    output.setEncoding("utf8");
    output.on("data", (chunk) => {
      outputText += String(chunk);
    });
    const prompt = new TerminalTokenPrompt(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
    );

    input.end("sk_test\ny\n");

    await expect(prompt.askToken("http://localhost:8080")).resolves.toEqual({
      token: "sk_test",
      save: true,
    });
    expect(outputText).toContain("SkillHub token not found for http://localhost:8080.");
    expect(outputText).toContain("Paste SkillHub token:");
    expect(outputText).toContain("Save token locally? [Y/n]");
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

  test("preserves the original cause when the registry is unreachable", async () => {
    const cause = new TypeError("fetch failed");
    const fetchImpl: typeof fetch = async () => {
      throw cause;
    };

    await expect(new SkillHubClient("http://localhost:3000", "secret-token", fetchImpl).whoami()).rejects.toMatchObject({
      message: "SkillHub registry unreachable.",
      cause,
    });
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
  test("keeps SkillHub locks isolated by profile", async () => {
    const root = await makeTempRoot();
    await writeSkillHubLock(root, {
      version: 1,
      profile: "yanan.zhao",
      registry: "http://localhost:3000",
      generatedAt: "",
      skills: [],
    });

    const lock = await readSkillHubLock(root, "kaibin.xu", "http://localhost:3000");

    expect(lock).toMatchObject({
      version: 1,
      profile: "kaibin.xu",
      registry: "http://localhost:3000",
      skills: [],
    });
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

  test("preserves binary assets from SkillHub packages", async () => {
    const root = await makeTempRoot();
    const logoBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x80, 0x41]);
    const zip = zipSync({
      "SKILL.md": strToU8("# Demo Skill\n"),
      "assets/logo.png": logoBytes,
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
      platforms: ["claude"],
    });
    const files = await collectSkillHubManagedFiles({
      targetRoot: root,
      registry: "http://localhost:3000",
      lockEntries: [entry],
      platforms: ["claude"],
    });

    const logo = files.find((file) => file.relativePath.endsWith("assets/logo.png"));
    expect(logo?.content).toBeInstanceOf(Uint8Array);
    expect([...(logo?.content as Uint8Array)]).toEqual([...logoBytes]);
  });

  test("redownloads cached skills when the resolved fingerprint changes", async () => {
    const root = await makeTempRoot();
    let resolveCount = 0;
    let downloadCount = 0;
    const client = {
      registry: "http://localhost:3000",
      token: undefined,
      whoami: async () => ({ handle: "yanan.zhao", displayName: "Yanan Zhao" }),
      search: async () => ({ items: [], total: 0, limit: 0 }),
      discover: async () => ({ items: [], total: 0, page: 0, size: 0 }),
      resolve: async () => {
        resolveCount += 1;
        return {
          namespace: "global",
          slug: "demo",
          version: "1.0.0",
          versionId: 42,
          fingerprint: resolveCount === 1 ? "sha256:old" : "sha256:new",
          downloadUrl: "/download",
        };
      },
      download: async () => {
        downloadCount += 1;
        return zipSync({
          "SKILL.md": strToU8(downloadCount === 1 ? "# Old Skill\n" : "# New Skill\n"),
        }).buffer as ArrayBuffer;
      },
    } as unknown as SkillHubClient;

    await ensureCachedSkill({
      targetRoot: root,
      registry: "http://localhost:3000",
      client,
      namespace: "global",
      slug: "demo",
      platforms: ["claude"],
    });
    const updatedEntry = await ensureCachedSkill({
      targetRoot: root,
      registry: "http://localhost:3000",
      client,
      namespace: "global",
      slug: "demo",
      platforms: ["claude"],
    });
    const files = await collectSkillHubManagedFiles({
      targetRoot: root,
      registry: "http://localhost:3000",
      lockEntries: [updatedEntry],
      platforms: ["claude"],
    });

    expect(downloadCount).toBe(2);
    expect(updatedEntry.fingerprint).toBe("sha256:new");
    expect(files.find((file) => file.relativePath.endsWith("SKILL.md"))?.content).toContain("# New Skill");
  });

  test("preserves the existing cache when replacement package extraction fails", async () => {
    const root = await makeTempRoot();
    const cachedClient = createSkillClient({
      resolve: {
        namespace: "global",
        slug: "demo",
        version: "1.0.0",
        versionId: 42,
        fingerprint: "sha256:old",
        downloadUrl: "/download",
      },
      download: zipSync({ "SKILL.md": strToU8("# Old Skill\n") }).buffer as ArrayBuffer,
    });
    const cachedEntry = await ensureCachedSkill({
      targetRoot: root,
      registry: "http://localhost:3000",
      client: cachedClient,
      namespace: "global",
      slug: "demo",
      platforms: ["claude"],
    });
    const failingClient = createSkillClient({
      resolve: {
        namespace: "global",
        slug: "demo",
        version: "1.0.0",
        versionId: 43,
        fingerprint: "sha256:new",
        downloadUrl: "/download",
      },
      download: zipSync({
        "SKILL.md": strToU8("# Broken Skill\n"),
        "/escape.md": strToU8("bad\n"),
      }).buffer as ArrayBuffer,
    });

    await expect(
      ensureCachedSkill({
        targetRoot: root,
        registry: "http://localhost:3000",
        client: failingClient,
        namespace: "global",
        slug: "demo",
        platforms: ["claude"],
      }),
    ).rejects.toThrow("Unsafe SkillHub package entry path");

    await expect(hasCachedSkill(root, "http://localhost:3000", cachedEntry)).resolves.toBe(true);
    const files = await collectSkillHubManagedFiles({
      targetRoot: root,
      registry: "http://localhost:3000",
      lockEntries: [cachedEntry],
      platforms: ["claude"],
    });
    expect(files.find((file) => file.relativePath.endsWith("SKILL.md"))?.content).toContain("# Old Skill");
  });

  test("does not treat a failed fresh extraction as a cached skill", async () => {
    const root = await makeTempRoot();
    const client = createSkillClient({
      resolve: {
        namespace: "global",
        slug: "demo",
        version: "1.0.0",
        versionId: 42,
        fingerprint: "sha256:abc",
        downloadUrl: "/download",
      },
      download: zipSync({
        "SKILL.md": strToU8("# Broken Skill\n"),
        "/escape.md": strToU8("bad\n"),
      }).buffer as ArrayBuffer,
    });

    await expect(
      ensureCachedSkill({
        targetRoot: root,
        registry: "http://localhost:3000",
        client,
        namespace: "global",
        slug: "demo",
        platforms: ["claude"],
      }),
    ).rejects.toThrow("Unsafe SkillHub package entry path");

    await expect(
      hasCachedSkill(root, "http://localhost:3000", {
        namespace: "global",
        slug: "demo",
        version: "1.0.0",
        versionId: 42,
        fingerprint: "sha256:abc",
        installTargets: [],
        status: "installed",
        updatedAt: "",
      }),
    ).resolves.toBe(false);
  });

  test("does not render forbidden or missing SkillHub lock entries from cache", async () => {
    const root = await makeTempRoot();
    const zip = zipSync({
      "SKILL.md": strToU8("# Demo Skill\n"),
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
      platforms: ["claude"],
    });

    const files = await collectSkillHubManagedFiles({
      targetRoot: root,
      registry: "http://localhost:3000",
      lockEntries: [
        { ...entry, status: "forbidden" },
        { ...entry, status: "missing_remote" },
      ],
      platforms: ["claude"],
    });

    expect(files).toEqual([]);
  });

  test("expands selector selections through discover and installs matching skills", async () => {
    const root = await makeTempRoot();
    const discoverQueries: unknown[] = [];
    const resolvedSlugs: string[] = [];
    const downloadedSlugs: string[] = [];
    const client = {
      registry: "http://localhost:3000",
      token: undefined,
      whoami: async () => ({ handle: "yanan.zhao", displayName: "Yanan Zhao" }),
      search: async () => ({ items: [], total: 0, limit: 0 }),
      discover: async (query: unknown) => {
        discoverQueries.push(query);
        return {
          items: [
            { namespace: "emrois", slug: "api-review", publishedVersion: "1.0.0" },
            { namespace: "emrois", slug: "security-review", publishedVersion: "1.1.0" },
          ],
          total: 2,
          page: 0,
          size: 100,
        };
      },
      resolve: async (namespace: string, slug: string) => {
        resolvedSlugs.push(slug);
        return {
          namespace,
          slug,
          version: slug === "api-review" ? "1.0.0" : "1.1.0",
          versionId: slug === "api-review" ? 10 : 11,
          fingerprint: `sha256:${slug}`,
          downloadUrl: "/download",
        };
      },
      download: async (_namespace: string, slug: string) => {
        downloadedSlugs.push(slug);
        return zipSync({ "SKILL.md": strToU8(`# ${slug}\n`) }).buffer as ArrayBuffer;
      },
    } as unknown as SkillHubClient;

    const result = await syncSelectedSkills({
      targetRoot: root,
      profile: "yanan.zhao",
      registry: "http://localhost:3000",
      client,
      selections: [{ namespace: "emrois", owner: "self", label: "active", policy: "prompt-new" }],
      platforms: ["claude"],
      autoRefresh: true,
    });

    expect(discoverQueries).toEqual([
      {
        namespace: "emrois",
        owner: "self",
        ownerId: undefined,
        label: "active",
        page: 0,
        size: 100,
      },
    ]);
    expect(resolvedSlugs).toEqual(["api-review", "security-review"]);
    expect(downloadedSlugs).toEqual(["api-review", "security-review"]);
    expect(result.lock.skills.map((skill) => `${skill.namespace}/${skill.slug}@${skill.version}`)).toEqual([
      "emrois/api-review@1.0.0",
      "emrois/security-review@1.1.0",
    ]);
    expect(result.lock.skills.every((skill) => skill.selector?.label === "active")).toBe(true);
    expect(result.messages).toContain("Installed SkillHub skill emrois/api-review@1.0.0");
    expect(result.messages).toContain("Installed SkillHub skill emrois/security-review@1.1.0");
  });

  test("marks selector-managed lock entries missing when discover no longer returns them", async () => {
    const root = await makeTempRoot();
    await writeSkillHubLock(root, {
      version: 1,
      profile: "yanan.zhao",
      registry: "http://localhost:3000",
      generatedAt: "",
      skills: [
        {
          namespace: "emrois",
          slug: "api-review",
          selector: { namespace: "emrois", owner: "self", label: "active", policy: "prompt-new" },
          version: "1.0.0",
          versionId: 10,
          fingerprint: "sha256:api-review",
          installTargets: [{ agent: "claude", path: ".claude/skills/skillhub-emrois-api-review" }],
          status: "installed",
          updatedAt: "2026-06-15T00:00:00.000Z",
        },
        {
          namespace: "emrois",
          slug: "security-review",
          selector: { namespace: "emrois", owner: "self", label: "active", policy: "prompt-new" },
          version: "1.1.0",
          versionId: 11,
          fingerprint: "sha256:security-review",
          installTargets: [{ agent: "claude", path: ".claude/skills/skillhub-emrois-security-review" }],
          status: "installed",
          updatedAt: "2026-06-15T00:00:00.000Z",
        },
      ],
    });
    const client = {
      registry: "http://localhost:3000",
      token: undefined,
      whoami: async () => ({ handle: "yanan.zhao", displayName: "Yanan Zhao" }),
      search: async () => ({ items: [], total: 0, limit: 0 }),
      discover: async () => ({
        items: [{ namespace: "emrois", slug: "api-review", publishedVersion: "1.0.0" }],
        total: 1,
        page: 0,
        size: 100,
      }),
      resolve: async (namespace: string, slug: string) => ({
        namespace,
        slug,
        version: "1.0.0",
        versionId: 10,
        fingerprint: "sha256:api-review",
        downloadUrl: "/download",
      }),
      download: async () => zipSync({ "SKILL.md": strToU8("# API Review\n") }).buffer as ArrayBuffer,
    } as unknown as SkillHubClient;

    const result = await syncSelectedSkills({
      targetRoot: root,
      profile: "yanan.zhao",
      registry: "http://localhost:3000",
      client,
      selections: [{ namespace: "emrois", owner: "self", label: "active", policy: "prompt-new" }],
      platforms: ["claude"],
      autoRefresh: true,
    });

    expect(result.lock.skills.find((skill) => skill.slug === "api-review")?.status).toBe("installed");
    expect(result.lock.skills.find((skill) => skill.slug === "security-review")?.status).toBe("missing_remote");
    expect(result.messages).toContainEqual({
      text: "SkillHub skill emrois/security-review is missing from selector results",
      tone: "warning",
    });
  });

  test("disables stale explicit lock entries when selections shrink", async () => {
    const root = await makeTempRoot();
    const apiClient = createSkillClient({
      resolve: {
        namespace: "emrois",
        slug: "api-review",
        version: "1.0.0",
        versionId: 10,
        fingerprint: "sha256:api-review",
        downloadUrl: "/download",
      },
      download: zipSync({ "SKILL.md": strToU8("# API Review\n") }).buffer as ArrayBuffer,
    });
    const securityClient = createSkillClient({
      resolve: {
        namespace: "emrois",
        slug: "security-review",
        version: "1.1.0",
        versionId: 11,
        fingerprint: "sha256:security-review",
        downloadUrl: "/download",
      },
      download: zipSync({ "SKILL.md": strToU8("# Security Review\n") }).buffer as ArrayBuffer,
    });
    const apiEntry = await ensureCachedSkill({
      targetRoot: root,
      registry: "http://localhost:3000",
      client: apiClient,
      namespace: "emrois",
      slug: "api-review",
      selector: { namespace: "emrois", slug: "api-review", policy: "auto" },
      platforms: ["claude"],
    });
    const securityEntry = await ensureCachedSkill({
      targetRoot: root,
      registry: "http://localhost:3000",
      client: securityClient,
      namespace: "emrois",
      slug: "security-review",
      selector: { namespace: "emrois", slug: "security-review", policy: "auto" },
      platforms: ["claude"],
    });
    await writeSkillHubLock(root, {
      version: 1,
      profile: "yanan.zhao",
      registry: "http://localhost:3000",
      generatedAt: "",
      skills: [apiEntry, securityEntry],
    });
    const client = {
      registry: "http://localhost:3000",
      token: undefined,
      whoami: async () => ({ handle: "yanan.zhao", displayName: "Yanan Zhao" }),
      search: async () => ({ items: [], total: 0, limit: 0 }),
      discover: async () => ({ items: [], total: 0, page: 0, size: 0 }),
      resolve: async (namespace: string, slug: string) => ({
        namespace,
        slug,
        version: "1.0.0",
        versionId: 10,
        fingerprint: "sha256:api-review",
        downloadUrl: "/download",
      }),
      download: async () => zipSync({ "SKILL.md": strToU8("# API Review\n") }).buffer as ArrayBuffer,
    } as unknown as SkillHubClient;

    const result = await syncSelectedSkills({
      targetRoot: root,
      profile: "yanan.zhao",
      registry: "http://localhost:3000",
      client,
      selections: [{ namespace: "emrois", slug: "api-review", policy: "auto" }],
      platforms: ["claude"],
      autoRefresh: true,
    });

    expect(result.lock.skills.find((skill) => skill.slug === "api-review")?.status).toBe("installed");
    expect(result.lock.skills.find((skill) => skill.slug === "security-review")?.status).toBe("disabled");
    expect(result.messages).toContainEqual({
      text: "Disabled SkillHub skill emrois/security-review because it is no longer selected",
      tone: "warning",
    });

    const files = await collectSkillHubManagedFiles({
      targetRoot: root,
      registry: "http://localhost:3000",
      lockEntries: result.lock.skills,
      platforms: ["claude"],
    });
    expect(files.map((file) => file.relativePath)).toEqual([
      ".claude/skills/skillhub-emrois-api-review/SKILL.md",
    ]);
  });

  test("reports selected skills that become forbidden or missing remotely", async () => {
    const root = await makeTempRoot();
    await writeSkillHubLock(root, {
      version: 1,
      profile: "yanan.zhao",
      registry: "http://localhost:3000",
      generatedAt: "",
      skills: [
        {
          namespace: "global",
          slug: "forbidden-skill",
          version: "1.0.0",
          versionId: 10,
          fingerprint: "sha256:forbidden",
          installTargets: [{ agent: "claude", path: ".claude/skills/skillhub-global-forbidden-skill" }],
          status: "installed",
          updatedAt: "2026-06-15T00:00:00.000Z",
        },
        {
          namespace: "global",
          slug: "missing-skill",
          version: "1.0.0",
          versionId: 11,
          fingerprint: "sha256:missing",
          installTargets: [{ agent: "claude", path: ".claude/skills/skillhub-global-missing-skill" }],
          status: "installed",
          updatedAt: "2026-06-15T00:00:00.000Z",
        },
      ],
    });
    const client = {
      registry: "http://localhost:3000",
      token: undefined,
      whoami: async () => ({ handle: "yanan.zhao", displayName: "Yanan Zhao" }),
      search: async () => ({ items: [], total: 0, limit: 0 }),
      discover: async () => ({ items: [], total: 0, page: 0, size: 0 }),
      resolve: async (_namespace: string, slug: string) => {
        if (slug === "forbidden-skill") {
          throw new SkillHubError("SkillHub access denied.", { status: 403, registry: "http://localhost:3000" });
        }
        throw new SkillHubError("SkillHub resource not found.", { status: 404, registry: "http://localhost:3000" });
      },
      download: async () => new ArrayBuffer(0),
    } as unknown as SkillHubClient;

    const result = await syncSelectedSkills({
      targetRoot: root,
      profile: "yanan.zhao",
      registry: "http://localhost:3000",
      client,
      selections: [
        { namespace: "global", slug: "forbidden-skill", policy: "auto" },
        { namespace: "global", slug: "missing-skill", policy: "auto" },
      ],
      platforms: ["claude"],
      autoRefresh: true,
    });

    expect(result.lock.skills.find((skill) => skill.slug === "forbidden-skill")?.status).toBe("forbidden");
    expect(result.lock.skills.find((skill) => skill.slug === "missing-skill")?.status).toBe("missing_remote");
    expect(result.messages).toContainEqual({
      text: "SkillHub skill global/forbidden-skill is forbidden for the current token",
      tone: "warning",
    });
    expect(result.messages).toContainEqual({
      text: "SkillHub skill global/missing-skill is missing from the registry",
      tone: "warning",
    });
  });

  test("frozen sync uses locked cache when the registry is unreachable", async () => {
    const root = await makeTempRoot();
    const cachedClient = createSkillClient({
      resolve: {
        namespace: "global",
        slug: "demo",
        version: "1.0.0",
        versionId: 42,
        fingerprint: "sha256:abc",
        downloadUrl: "/download",
      },
      download: zipSync({ "SKILL.md": strToU8("# Demo Skill\n") }).buffer as ArrayBuffer,
    });
    const cachedEntry = await ensureCachedSkill({
      targetRoot: root,
      registry: "http://localhost:3000",
      client: cachedClient,
      namespace: "global",
      slug: "demo",
      platforms: ["claude"],
    });
    await writeSkillHubLock(root, {
      version: 1,
      profile: "yanan.zhao",
      registry: "http://localhost:3000",
      generatedAt: "",
      skills: [cachedEntry],
    });
    const offlineClient = {
      ...cachedClient,
      resolve: async () => {
        throw new SkillHubError("SkillHub registry unreachable.", { registry: "http://localhost:3000" });
      },
    } as unknown as SkillHubClient;

    const result = await syncSelectedSkills({
      targetRoot: root,
      profile: "yanan.zhao",
      registry: "http://localhost:3000",
      client: offlineClient,
      selections: [{ namespace: "global", slug: "demo", policy: "auto" }],
      platforms: ["claude"],
      autoRefresh: true,
      frozen: true,
    });

    expect(result.changed).toBe(false);
    expect(result.lock.skills).toEqual([cachedEntry]);
    expect(result.messages).toContainEqual({
      text: "SkillHub registry unreachable; frozen mode using cached global/demo@1.0.0",
      tone: "warning",
    });
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
