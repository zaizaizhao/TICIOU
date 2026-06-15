# Ticiou 与 SkillHub 集成实现说明

本文解释本轮 Ticiou + SkillHub 集成做了哪些接口和代码修改、每个命令如何工作、完整工作流如何从 CLI 走到 SkillHub API 再回到本地渲染文件。

## 结论：SkillHub 有接口更改

有。SkillHub 新增了面向原生 CLI/集成客户端的发现接口：

```http
GET /api/cli/v1/skills/discover
```

这个接口用于 Ticiou 的：

```bash
ticiou skill list --remote
```

它支持以下查询参数：

| 参数 | 含义 | 示例 |
| --- | --- | --- |
| `q` | 搜索关键词 | `q=review` |
| `namespace` | 命名空间过滤 | `namespace=emrois` |
| `owner=self` | 当前 token 对应用户拥有的技能 | `owner=self` |
| `ownerId` | 指定 owner user id | `ownerId=local-user` |
| `label` | 标签过滤，可重复 | `label=active&label=review` |
| `visibility` | 可见性过滤 | `visibility=PUBLIC` |
| `sort` | 排序 | `sort=newest` |
| `page` | 页码，从 0 开始 | `page=0` |
| `size` | 每页数量，最大 100 | `size=100` |

响应类型由 SkillHub 新增 DTO 表达：

```java
// skillhub/server/skillhub-app/src/main/java/com/iflytek/skillhub/dto/cli/CliDiscoverResponse.java
public record CliDiscoverResponse(
        List<CliDiscoverItemResponse> items,
        long total,
        int page,
        int size
) {}
```

```java
// skillhub/server/skillhub-app/src/main/java/com/iflytek/skillhub/dto/cli/CliDiscoverItemResponse.java
public record CliDiscoverItemResponse(
        String namespace,
        String slug,
        String displayName,
        String summary,
        String ownerId,
        String ownerDisplayName,
        String visibility,
        String status,
        String publishedVersion,
        Long publishedVersionId,
        String fingerprint,
        List<String> labels,
        Instant updatedAt
) {}
```

Ticiou 通过自己的 HTTP client 调用该接口：

```ts
// TICIOU/src/skillhub/client.ts
async discover(query: DiscoverQuery): Promise<DiscoverResponse> {
  const params = new URLSearchParams();
  appendParam(params, "q", query.q);
  appendParam(params, "namespace", query.namespace);
  appendParam(params, "owner", query.owner);
  appendParam(params, "ownerId", query.ownerId);
  appendParam(params, "label", query.label);
  appendParam(params, "visibility", query.visibility);
  appendParam(params, "sort", query.sort);
  return this.getJson(`/skills/discover?${params.toString()}`);
}
```

## 文件改动导航

### Ticiou

| 文件/目录 | 作用 |
| --- | --- |
| `src/cli/program.ts` | 注册 `skillhub` 和 `skill` 命令，以及 `use` 的 SkillHub 参数 |
| `src/app/commands/skillhub/*` | `login`、`whoami`、`logout` 命令实现 |
| `src/app/commands/skill/*` | `list`、`add`、`remove`、`sync` 命令实现 |
| `src/skillhub/client.ts` | SkillHub HTTP API client |
| `src/skillhub/credentials.ts` | token 解析和 `~/.ticiou/skillhub-credentials.json` 本机凭据 |
| `src/skillhub/selection.ts` | profile selection 读写和 skill ref 解析 |
| `src/skillhub/sync.ts` | resolve/download/cache/lock 同步主流程 |
| `src/skillhub/install.ts` | zip 安全解压、cache 到平台输出文件的转换 |
| `src/skillhub/lock.ts` | `.ticiou/.runtime/skillhub-lock.json` 读写 |
| `src/project/config.ts` | `.ticiou/config.yaml` 结构化解析和序列化 |
| `src/app/commands/profile/use.ts` | `ticiou use` 接入 SkillHub selection |
| `src/infra/fs.ts`、`src/infra/target-root.ts` | 路径边界和 git root 判断，增强 Windows/macOS 兼容性 |
| `test/skillhub.test.ts` | SkillHub 集成相关单元测试 |
| `README.md`、`task.md` | 使用说明和任务完成记录 |

### SkillHub

| 文件/目录 | 作用 |
| --- | --- |
| `server/skillhub-app/src/main/java/.../controller/cli/CliSkillController.java` | 新增 `GET /api/cli/v1/skills/discover` |
| `server/skillhub-app/src/main/java/.../service/cli/CliSkillAppService.java` | 组装 CLI discovery response |
| `server/skillhub-app/src/main/java/.../dto/cli/CliDiscover*.java` | 新增 discovery DTO |
| `server/skillhub-app/src/main/java/.../service/SkillSearchAppService.java` | 搜索支持 owner/visibility/labels 组合过滤 |
| `server/skillhub-search/src/main/java/.../SearchQuery.java` | 搜索请求模型新增 `visibility` |
| `server/skillhub-search/src/main/java/.../PostgresFullTextQueryService.java` | SQL 下推 owner/visibility/label 过滤，并同步 count query |
| `server/skillhub-auth/src/main/java/.../RouteSecurityPolicyRegistry.java` | 允许匿名和 API token 访问 discovery |
| `web/src/api/generated/schema.d.ts` | OpenAPI 生成类型新增 discover path 和 response |
| `README.md`、`README_zh.md` | 记录新 discovery 接口 |

## SkillHub 接口实现解释

### 1. Controller：暴露 `/discover`

入口代码：

```java
// skillhub/server/skillhub-app/src/main/java/com/iflytek/skillhub/controller/cli/CliSkillController.java
@GetMapping("/discover")
@RateLimit(category = "search", authenticated = 60, anonymous = 20)
public ApiResponse<CliDiscoverResponse> discover(
        @RequestParam(required = false) String q,
        @RequestParam(required = false) String namespace,
        @RequestParam(required = false) String owner,
        @RequestParam(required = false) String ownerId,
        @RequestParam(name = "label", required = false) List<String> labels,
        @RequestParam(required = false) String visibility,
        @RequestParam(required = false) String sort,
        @RequestParam(required = false) String page,
        @RequestParam(required = false) String size,
        @RequestAttribute(value = "userId", required = false) String userId,
        @RequestAttribute(value = "userNsRoles", required = false) Map<Long, NamespaceRole> userNsRoles) {
    return ok("response.success.read", cliSkillAppService.discover(
            q,
            namespace,
            resolveOwnerId(owner, ownerId, userId),
            labels,
            resolveVisibility(visibility),
            sort,
            parseNonNegativeInt(page, DEFAULT_PAGE),
            parsePositiveInt(size, DEFAULT_SIZE),
            userId,
            userNsRoles
    ));
}
```

关键点：

- Controller 只做 HTTP 参数绑定、轻量校验和 response 包装，符合 SkillHub `AGENTS.md` 的层次要求。
- `owner=self` 会在 Controller 中解析成当前 `userId`。
- 匿名请求传 `owner=self` 会抛 `UnauthorizedException`，因为没有当前用户。
- `size` 使用 `parsePositiveInt`，最大限制为 100，避免 CLI 一次拉取过多数据。
- `visibility` 使用 `SkillVisibility.valueOf(... Locale.ROOT)` 校验，非法值返回业务错误。

owner 解析逻辑：

```java
private String resolveOwnerId(String owner, String ownerId, String userId) {
    if (owner != null && !owner.isBlank() && ownerId != null && !ownerId.isBlank()) {
        throw new DomainBadRequestException("error.skill.discover.owner.conflict");
    }
    if (owner == null || owner.isBlank()) {
        return ownerId;
    }
    if (!"self".equalsIgnoreCase(owner.trim())) {
        throw new DomainBadRequestException("error.skill.discover.owner.invalid", owner);
    }
    if (userId == null || userId.isBlank()) {
        throw new UnauthorizedException("error.auth.required");
    }
    return userId;
}
```

### 2. App Service：组装 CLI 响应

入口代码：

```java
// skillhub/server/skillhub-app/src/main/java/com/iflytek/skillhub/service/cli/CliSkillAppService.java
public CliDiscoverResponse discover(
        String q,
        String namespace,
        String ownerId,
        List<String> labels,
        String visibility,
        String sort,
        int page,
        int size,
        String userId,
        Map<Long, NamespaceRole> userNsRoles) {
    SkillSearchAppService.SearchResponse response = skillSearchAppService.search(
            q,
            namespace,
            sort != null && !sort.isBlank() ? sort : "newest",
            page,
            size,
            labels,
            ownerId,
            visibility,
            userId,
            userNsRoles
    );

    List<CliDiscoverItemResponse> items = response.items().stream()
            .map(item -> toDiscoverItem(item, userId, userNsRoles))
            .toList();

    return new CliDiscoverResponse(items, response.total(), page, size);
}
```

这里的职责是工作流编排：

1. 调用 `SkillSearchAppService.search(...)` 获取符合权限和过滤条件的 skill summary。
2. 对每个 summary 补充 CLI 需要的字段：
   - owner 信息：`skillQueryService.getSkillDetail(...)`
   - fingerprint：`skillQueryService.resolveVersion(...)`
   - labels：`skillLabelAppService.listSkillLabelsBySkillId(...)`
3. 返回稳定的 CLI response DTO。

单项映射：

```java
private CliDiscoverItemResponse toDiscoverItem(
        SkillSummaryResponse item,
        String userId,
        Map<Long, NamespaceRole> userNsRoles) {
    SkillQueryService.SkillDetailDTO detail = skillQueryService.getSkillDetail(
            item.namespace(),
            item.slug(),
            userId,
            userNsRoles
    );
    SkillQueryService.ResolvedVersionDTO resolved = item.publishedVersion() == null
            ? null
            : skillQueryService.resolveVersion(
                    item.namespace(),
                    item.slug(),
                    item.publishedVersion().version(),
                    null,
                    null,
                    userId,
                    userNsRoles
            );

    return new CliDiscoverItemResponse(
            item.namespace(),
            item.slug(),
            item.displayName(),
            item.summary(),
            detail.ownerId(),
            detail.ownerDisplayName(),
            item.visibility(),
            item.status(),
            item.publishedVersion() != null ? item.publishedVersion().version() : null,
            item.publishedVersion() != null ? item.publishedVersion().id() : null,
            resolved != null ? resolved.fingerprint() : null,
            skillLabelAppService.listSkillLabelsBySkillId(item.id()).stream()
                    .map(com.iflytek.skillhub.dto.SkillLabelDto::slug)
                    .toList(),
            item.updatedAt()
    );
}
```

### 3. Search 层：支持 owner/visibility/labels 组合过滤

`SkillSearchAppService` 增加新的 overload，把 CLI discovery 的过滤条件传进搜索层：

```java
// skillhub/server/skillhub-app/src/main/java/com/iflytek/skillhub/service/SkillSearchAppService.java
public SearchResponse search(
        String keyword,
        String namespaceSlug,
        String sortBy,
        int page,
        int size,
        List<String> labelSlugs,
        String ownerId,
        String visibility,
        String userId,
        Map<Long, NamespaceRole> userNsRoles) {
    Long namespaceId = resolveNamespaceId(namespaceSlug, userId, userNsRoles);
    SearchVisibilityScope scope = buildVisibilityScope(userId, userNsRoles);

    return searchVisibleSkills(
            keyword,
            namespaceId,
            sortBy != null ? sortBy : "newest",
            page,
            size,
            labelSlugs,
            normalizeOwnerId(ownerId),
            normalizeVisibility(visibility),
            scope
    );
}
```

这里把用户权限和过滤条件转成 `SearchQuery`：

```java
SearchResult result = searchQueryService.search(new SearchQuery(
        keyword,
        namespaceId,
        scope,
        sortBy,
        page,
        size,
        normalizeLabelSlugs(labelSlugs),
        ownerId,
        visibility
));
```

`SearchQuery` 也增加了 `visibility` 字段：

```java
// skillhub/server/skillhub-search/src/main/java/com/iflytek/skillhub/search/SearchQuery.java
public record SearchQuery(
        String keyword,
        Long namespaceId,
        SearchVisibilityScope visibilityScope,
        String sortBy,
        int page,
        int size,
        List<String> labelSlugs,
        String ownerId,
        String visibility
) {}
```

### 4. PostgreSQL 搜索实现：过滤下推到 SQL

在 `PostgresFullTextQueryService` 中新增过滤条件：

```java
// skillhub/server/skillhub-search/src/main/java/com/iflytek/skillhub/search/postgres/PostgresFullTextQueryService.java
if (query.ownerId() != null) {
    sql.append("AND d.owner_id = :ownerId ");
}

if (query.visibility() != null) {
    sql.append("AND d.visibility = :visibility ");
}

if (query.labelSlugs() != null && !query.labelSlugs().isEmpty()) {
    sql.append("AND d.skill_id IN (");
    sql.append("SELECT sl.skill_id FROM skill_label sl ");
    sql.append("JOIN label_definition ld ON ld.id = sl.label_id ");
    sql.append("WHERE LOWER(ld.slug) IN :labelSlugs");
    sql.append(") ");
}
```

并且 count query 也设置同样参数，保证分页总数正确：

```java
if (query.ownerId() != null) {
    countQuery.setParameter("ownerId", query.ownerId());
}

if (query.visibility() != null) {
    countQuery.setParameter("visibility", query.visibility());
}
```

这比在 service 层搜索后再过滤更可靠，因为：

- `total` 与过滤结果一致。
- 分页不会先取出错误页再过滤。
- 数据库可以利用索引和 join 做过滤。

### 5. 鉴权策略：匿名和 API token 都能发现

`RouteSecurityPolicyRegistry` 新增：

```java
// skillhub/server/skillhub-auth/src/main/java/com/iflytek/skillhub/auth/policy/RouteSecurityPolicyRegistry.java
RouteAuthorizationPolicy.permitAll(HttpMethod.GET, "/api/cli/v1/skills/discover"),
ApiTokenPolicy.allow(HttpMethod.GET, "/api/cli/v1/skills/discover"),
```

语义是：

- 没 token：允许访问，但只能按 visibility scope 看到 PUBLIC。
- 有 API token：允许访问，并由 request context projection 提供 `userId` 和 namespace roles，从而能看到授权的 NAMESPACE_ONLY/private-like 数据。
- `owner=self` 需要当前用户身份；匿名时会在 Controller 抛 401。

### 6. OpenAPI 类型

因为 Controller 合约变了，已运行：

```bash
make generate-api
```

生成结果在：

```text
skillhub/web/src/api/generated/schema.d.ts
```

其中包含：

```ts
"/api/cli/v1/skills/discover": {
  get: operations["discover"];
}
```

和：

```ts
ApiResponseCliDiscoverResponse
CliDiscoverItemResponse
CliDiscoverResponse
```

## Ticiou 侧实现解释

### 1. CLI 命令注册

Ticiou 的命令入口在：

```text
TICIOU/src/cli/program.ts
```

新增两个命令组：

```ts
const skillhub = program.command("skillhub").description("Manage SkillHub credentials");
const skill = program.command("skill").description("Manage SkillHub skills for the active profile");
```

`use` 也新增了 SkillHub 相关参数：

```ts
program
  .command("use")
  .requiredOption("-u, --user <user>", "User profile id")
  .option("--registry <url>", "SkillHub registry URL")
  .option("--token <token>", "SkillHub token for this command only")
  .option("--ask-token", "Prompt for a SkillHub token when needed")
  .option("--anonymous", "Disable saved/env token lookup and use public SkillHub access")
  .option("--frozen", "Do not write SkillHub lock changes")
```

### 2. 凭据解析优先级

凭据解析在：

```text
TICIOU/src/skillhub/credentials.ts
```

优先级：

1. `--anonymous`
2. `--token`
3. `SKILLHUB_TOKEN`
4. `~/.ticiou/skillhub-credentials.json`
5. `--ask-token`
6. anonymous

代码：

```ts
export async function resolveToken(options: ResolveTokenOptions): Promise<ResolvedToken> {
  if (options.anonymous === true) {
    return { source: "anonymous", persistent: false };
  }

  if (options.token !== undefined && options.token.length > 0) {
    return { token: options.token, source: "flag", persistent: false };
  }

  const envToken = options.env?.SKILLHUB_TOKEN ?? process.env.SKILLHUB_TOKEN;
  if (envToken !== undefined && envToken.length > 0) {
    return { token: envToken, source: "env", persistent: false };
  }

  const store = new CredentialsStore(options.home);
  const storedToken = await store.getToken(options.registry ?? "");
  if (storedToken !== undefined && storedToken.length > 0) {
    return { token: storedToken, source: "ticiou-store", persistent: true };
  }
  ...
  return { source: "anonymous", persistent: false };
}
```

凭据文件路径：

```ts
// TICIOU/src/skillhub/credentials.ts
this.path = join(home, ".ticiou", "skillhub-credentials.json");
```

安全点：

- token 不写入项目 `.ticiou/config.yaml`。
- token 不写入 lock。
- 非 Windows 系统写入后 `chmod 0600`。
- Windows 上跳过 chmod，避免跨平台异常。

### 3. SkillHub HTTP client

HTTP client 位于：

```text
TICIOU/src/skillhub/client.ts
```

所有 API 都以：

```ts
`${registry}/api/cli/v1${path}`
```

作为前缀。

核心方法：

| 方法 | 调用接口 | 用途 |
| --- | --- | --- |
| `whoami()` | `GET /auth/whoami` | 校验 token 和当前用户 |
| `search()` | `GET /skills/search` | 旧 SkillHub fallback |
| `discover()` | `GET /skills/discover` | 新 discovery 接口 |
| `resolve()` | `GET /skills/{namespace}/{slug}/resolve` | 解析版本、fingerprint、downloadUrl |
| `download()` | `GET /skills/{namespace}/{slug}/versions/{version}/download` | 下载 skill zip |

下载跳转处理：

```ts
private async followDownloadRedirect(response: Response): Promise<ArrayBuffer> {
  const location = response.headers.get("location");
  const redirectUrl = new URL(location, this.registry).toString();
  const redirectOrigin = new URL(redirectUrl).origin;
  const registryOrigin = new URL(this.registry).origin;
  const redirected = await this.fetchImpl(redirectUrl, {
    headers: redirectOrigin === registryOrigin ? this.headers() : {},
  });
  return redirected.arrayBuffer();
}
```

这个逻辑避免把 Authorization token 发送给跨域预签名下载地址。

### 4. profile selection 写入

selection 管理在：

```text
TICIOU/src/skillhub/selection.ts
```

当执行：

```bash
ticiou skill add emrois/api-review
```

会形成：

```ts
{
  namespace: "emrois",
  slug: "api-review",
  version: undefined,
  policy: "auto"
}
```

当执行：

```bash
ticiou skill add --namespace emrois --owner self --label active
```

会形成 selector：

```ts
{
  namespace: "emrois",
  owner: "self",
  label: "active",
  policy: "prompt-new"
}
```

当前第一版同步流程只会安装 explicit skill selection：

```ts
export function explicitSkillSelections(selections: SkillHubSelection[]): SkillHubSelection[] {
  return selections.filter((selection) => selection.slug !== undefined && selection.slug.length > 0);
}
```

selector 已写入配置，为后续自动发现/增量同步保留结构。

### 5. lock 与 cache

lock 文件：

```text
.ticiou/.runtime/skillhub-lock.json
```

cache 目录：

```text
.ticiou/.runtime/skillhub-cache/<registry-hash>/<namespace>/<slug>/<version>/
```

lock 读写代码：

```ts
// TICIOU/src/skillhub/lock.ts
export async function readSkillHubLock(targetRoot: string, profile: string, registry: string)
```

关键保护：

```ts
if (parsed.profile !== profile || parsed.registry !== registry) {
  throw new Error(
    `SkillHub lock belongs to profile ... but current profile is ...`
  );
}
```

这样可以避免拿 A 用户或 A registry 的 lock 去渲染 B 用户/B registry。

### 6. 同步流程

同步主入口：

```text
TICIOU/src/skillhub/sync.ts
```

核心循环：

```ts
for (const selection of explicitSkillSelections(options.selections)) {
  const existing = findLockEntry(lock, selection.namespace, slug);

  if (options.frozen === true) {
    messages.push(...(await checkFrozenSelection(...)));
    continue;
  }

  if (
    existing !== undefined &&
    options.autoRefresh === false &&
    (await hasCachedSkill(...))
  ) {
    continue;
  }

  const nextEntry = await installWithStatus(...);
  lock = upsertLockEntry(lock, nextEntry);
}
```

普通模式：

1. 读取 lock。
2. 对 explicit skill selection 调用 SkillHub resolve。
3. 如 cache 缺失或允许刷新，下载 zip。
4. 安全解压到 cache。
5. 生成 lock entry。
6. 写回 lock。

`--frozen` 模式：

1. 调用 remote resolve 检查版本/fingerprint。
2. 检查本地 cache 是否存在。
3. 只返回提示信息。
4. 不写 lock。
5. 不下载 cache。
6. 不渲染新文件。

### 7. 安装和渲染

下载与 cache：

```ts
// TICIOU/src/skillhub/install.ts
export async function ensureCachedSkill(options: EnsureCachedSkillOptions): Promise<SkillHubLockEntry> {
  const resolved = await options.client.resolve(options.namespace, options.slug, options.version);
  const cacheRoot = skillCacheRoot(options.targetRoot, options.registry, resolved);

  if (!(await pathExists(join(cacheRoot, "SKILL.md")))) {
    const buffer = await options.client.download(options.namespace, options.slug, resolved.version);
    await rm(cacheRoot, { recursive: true, force: true });
    await extractZip(buffer, cacheRoot);
  }
  ...
}
```

zip 安全解压：

```ts
function safeJoin(targetDir: string, entryName: string): string {
  if (isAbsolute(entryName)) {
    throw new Error(`Unsafe SkillHub package entry path: ${entryName}`);
  }

  const root = resolve(targetDir);
  const target = resolve(root, entryName);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Unsafe SkillHub package entry path: ${entryName}`);
  }
  return target;
}
```

这防止 zip slip，例如 `../../evil` 或绝对路径。

生成平台 managed files：

```ts
export async function collectSkillHubManagedFiles(...): Promise<ManagedFile[]> {
  ...
  files.push({
    relativePath: posix.join(platformResourceRoot(platform, "skills"), outputDirectoryName, resourceFile),
    content,
    kind: "skills",
    platform,
    source: "skillhub",
  });
}
```

输出目录名：

```ts
export function skillHubOutputDirectoryName(namespace: string, slug: string): string {
  return `skillhub-${slugify(namespace)}-${slugify(slug)}`;
}
```

例如：

```text
emrois/api-review -> skillhub-emrois-api-review
```

Claude 输出路径：

```text
.claude/skills/skillhub-emrois-api-review/SKILL.md
```

Copilot 输出路径会走对应 platform resource root。

### 8. `ticiou use` 如何接入 SkillHub

`use` 的实现位于：

```text
TICIOU/src/app/commands/profile/use.ts
```

关键流程：

```ts
const skillHubConfig = getSkillHubRuntimeConfig(config, options.user, options.registry);
if (skillHubConfig.selections.length > 0) {
  const resolvedToken = await resolveToken(...);
  const client = new SkillHubClient(skillHubConfig.registry, resolvedToken.token);

  if (resolvedToken.token !== undefined) {
    const whoami = await client.whoami();
    if (whoami.handle !== options.user) {
      messages.push(`SkillHub token user ${whoami.handle} differs from Ticiou profile ${options.user}`);
    }
  }

  const syncResult = await syncSelectedSkills(...);
  managedFiles.push(...(await collectSkillHubManagedFiles(...)));
}
```

这说明 `ticiou use` 不只是本地 profile 渲染，它还会：

1. 读取当前用户 profile 的 SkillHub selections。
2. 解析 token。
3. 可选校验 token 用户和 Ticiou profile 是否一致。
4. 同步 SkillHub lock/cache。
5. 把 cache 中的 skill 转成 managed files。
6. 统一交给 `writeManagedFiles` 安全写入，继续复用 manifest/stale cleanup 机制。

## 每个命令的代码辅助解释

### `ticiou init`

入口：

```ts
// TICIOU/src/cli/program.ts
program.command("init").action(async (...) => initProject(...))
```

作用：

- 初始化当前目标目录的 `.ticiou/`。
- 创建基础 config/runtime 结构。
- 不访问 SkillHub。

典型输出目录：

```text
.ticiou/config.yaml
.ticiou/.runtime/
```

### `ticiou install claude|copilot`

入口：

```ts
program.command("install")
  .argument("<platform>", "Platform adapter: claude or copilot", parsePlatform)
  .action(async (platform, options) => installPlatform(...))
```

作用：

- 启用平台 adapter。
- 写入 `.ticiou/config.yaml` 的 platform 状态。
- 为后续 `use` 渲染到 `.claude/` 或 `.github/` 做准备。
- 不访问 SkillHub。

### `ticiou setup -u <user> -p <platform>`

入口：

```ts
program.command("setup")
  .requiredOption("-u, --user <user>")
  .option("-p, --platform <platform>", ..., collectPlatform, [])
  .action(async (options) => setupProject(...))
```

作用：

1. 执行 init。
2. 安装 platform adapter。
3. 执行 `use -u <user>`。
4. 如果该 user 已有 SkillHub selections，则也会触发 SkillHub sync/render。

### `ticiou use -u <user>`

入口：

```ts
program.command("use")
  .requiredOption("-u, --user <user>")
  .option("--registry <url>")
  .option("--token <token>")
  .option("--ask-token")
  .option("--anonymous")
  .option("--frozen")
  .action(async (options) => useProfile(...))
```

作用：

- 激活 Ticiou profile。
- 渲染 shared/user resources。
- 同步并渲染 SkillHub explicit selections。
- 写当前 active profile。
- 通过 manifest 清理 stale files。

SkillHub API 调用：

| 情况 | API |
| --- | --- |
| 有 token | `GET /api/cli/v1/auth/whoami` |
| explicit selection | `GET /api/cli/v1/skills/{namespace}/{slug}/resolve` |
| cache 缺失或刷新 | `GET /api/cli/v1/skills/{namespace}/{slug}/versions/{version}/download` |

写入：

```text
.ticiou/.runtime/skillhub-lock.json
.ticiou/.runtime/skillhub-cache/
.claude/skills/skillhub-<namespace>-<slug>/
.ticiou/.runtime/manifest.json
```

`--frozen`：

- 只检查 remote resolve 和 cache。
- 不写 lock。
- 不下载。
- 不新增渲染文件。

### `ticiou skillhub login --registry <url>`

入口：

```ts
skillhub.command("login")
  .option("--registry <url>")
  .option("--token <token>")
  .option("--no-save")
  .action(async (options) => loginSkillHub(...))
```

实现：

```ts
// TICIOU/src/app/commands/skillhub/login.ts
const registry = normalizeRegistry(options.registry);
const token = options.token ?? process.env.SKILLHUB_TOKEN ?? (await readTokenInteractively(registry));
const client = new SkillHubClient(registry, token);
const whoami = await client.whoami();
await new CredentialsStore().setToken(registry, token, whoami.handle);
```

作用：

1. 规范化 registry URL。
2. 获取 token：命令参数、环境变量或交互输入。
3. 调用 SkillHub `whoami` 验证 token。
4. 默认保存到 `~/.ticiou/skillhub-credentials.json`。

SkillHub API：

```http
GET /api/cli/v1/auth/whoami
Authorization: Bearer <token>
```

### `ticiou skillhub whoami`

入口：

```ts
skillhub.command("whoami")
  .option("--registry <url>")
  .option("--token <token>")
  .option("--ask-token")
  .option("--anonymous")
  .action(async (options) => whoamiSkillHub(...))
```

实现：

```ts
const resolvedToken = await resolveToken(...);
if (resolvedToken.token === undefined) {
  return { messages: ["Token source: anonymous", "No SkillHub user authenticated"] };
}
const whoami = await new SkillHubClient(registry, resolvedToken.token).whoami();
```

作用：

- 显示当前 registry。
- 显示 token 来源。
- 有 token 时显示 SkillHub 用户。
- anonymous 时不调用 whoami。

### `ticiou skillhub logout`

入口：

```ts
skillhub.command("logout")
  .option("--registry <url>")
  .action(async (options) => logoutSkillHub(...))
```

作用：

- 删除本机凭据文件中当前 registry 对应 token。
- 不访问 SkillHub。
- 不改项目文件。

### `ticiou skill list --remote`

入口：

```ts
skill.command("list")
  .option("--namespace <namespace>")
  .option("--owner <owner>")
  .option("--label <label>")
  .option("-q, --query <query>")
  .action(async (options) => listSkills(...))
```

实现：

```ts
// TICIOU/src/app/commands/skill/list.ts
const client = new SkillHubClient(skillHubConfig.registry, resolvedToken.token);
const result = await client.discover({
  q: query.q,
  namespace: query.namespace,
  owner: query.owner,
  label: query.label,
  page: 0,
  size: 100,
});
```

fallback：

```ts
if (error instanceof SkillHubError && error.status === 404) {
  const result = await client.search(query.q ?? "", 100);
  ...
}
```

作用：

- 优先调用新 discovery API。
- 如果老 SkillHub 没有 discovery，回退到旧 search API。
- 支持匿名列 PUBLIC skills。
- 支持 token 列授权范围内的 skills。

SkillHub API：

```http
GET /api/cli/v1/skills/discover?namespace=emrois&owner=self&label=active&page=0&size=100
```

### `ticiou skill add <namespace>/<slug>`

入口：

```ts
skill.command("add")
  .argument("[skill]", "Skill reference: <namespace>/<slug>")
  .option("--version <version>")
  .action(async (skillRef, options) => addSkill(...))
```

实现：

```ts
// TICIOU/src/app/commands/skill/add.ts
const selection = createSelection(options);
const added = addSelection(profileConfig, selection);
await writeConfig(targetRoot, config);
const useResult = await useProfile(...);
```

作用：

1. 解析 `namespace/slug`。
2. 写入 `.ticiou/config.yaml` 当前 profile 的 SkillHub selections。
3. 立即调用 `useProfile`，因此 add 后会尝试 resolve/download/render。

如果传 `--version`：

```ts
policy: options.version === undefined ? "auto" : "pinned"
```

### `ticiou skill add --namespace <namespace> --owner self --label <label>`

入口同 `skill add`。

作用：

- 写入 selector selection，而不是 explicit skill。
- 当前第一版不会自动安装 selector 匹配的全部 skills。
- 为后续 discovery 增量同步保留配置模型。

生成 selection：

```ts
return {
  namespace: options.namespace,
  owner: options.owner,
  ownerId: options.ownerId,
  label: options.label,
  policy: "prompt-new",
};
```

### `ticiou skill remove <namespace>/<slug>`

入口：

```ts
skill.command("remove")
  .argument("<skill>", "Skill reference: <namespace>/<slug>")
  .action(async (skillRef, options) => removeSkill(...))
```

作用：

- 从 `.ticiou/config.yaml` 当前 profile 的 explicit selection 中删除该 skill。
- 后续执行 `ticiou use` 或 `ticiou skill sync` 时，manifest stale cleanup 会清理不再管理的输出文件。
- 不访问 SkillHub。

### `ticiou skill sync`

入口：

```ts
skill.command("sync")
  .option("--registry <url>")
  .option("--token <token>")
  .option("--ask-token")
  .option("--anonymous")
  .option("--frozen")
  .action(async (options) => syncSkills(...))
```

实现：

```ts
// TICIOU/src/app/commands/skill/sync.ts
const syncResult = await syncSelectedSkills({
  targetRoot,
  profile: user,
  registry: skillHubConfig.registry,
  client: new SkillHubClient(skillHubConfig.registry, resolvedToken.token),
  selections: skillHubConfig.selections,
  platforms: getEnabledPlatforms(config),
  autoRefresh: true,
  frozen: options.frozen,
});
```

普通模式：

- resolve remote version。
- 下载缺失 cache。
- 更新 lock。
- 再调用 `useProfile(... frozen: true)` 渲染当前 lock/cache。

`--frozen`：

- 只检查 update/cache 状态。
- 不写 lock/cache。
- 不渲染新文件。

### `ticiou clear user`

作用：

- 清理当前 user profile 和 SkillHub source 的 managed files。
- 保留 shared 资源。
- 代码中已把 SkillHub 纳入 user clear：

```ts
// TICIOU/src/app/commands/profile/clear.ts
entry.source === "profile" || entry.source === "skillhub"
```

### `ticiou clear all`

作用：

- 清除所有 Ticiou managed files，包括 shared/profile/adapter/skillhub。
- 保留 `.ticiou/config.yaml` 和基础模板。

### `ticiou status`

作用：

- 显示当前 target、active profile、enabled platforms、generated file count。
- 不访问 SkillHub。

### `ticiou doctor`

作用：

- 检查平台目录、hooks、manifest、active profile 是否一致。
- 不主动访问 SkillHub。

## 完整工作流说明

### 工作流 A：登录并安装一个远端 skill

```bash
ticiou skillhub login --registry http://localhost:3000 --token sk_xxx
ticiou skill list --remote --namespace emrois --owner self --label active
ticiou skill add emrois/api-review
```

流程：

1. `login`
   - Ticiou 调 `GET /api/cli/v1/auth/whoami`。
   - SkillHub 验 token。
   - Ticiou 保存 token 到 `~/.ticiou/skillhub-credentials.json`。
2. `list`
   - Ticiou 解析 token。
   - 调 `GET /api/cli/v1/skills/discover?...`。
   - SkillHub 根据 token 投影 request context。
   - Search 层按 visibility、namespace、owner、label 过滤。
   - 返回 CLI discovery items。
3. `add`
   - Ticiou 写 `.ticiou/config.yaml`。
   - 立即执行 `useProfile`。
   - resolve skill 版本和 fingerprint。
   - 下载 zip。
   - 解压到 `.ticiou/.runtime/skillhub-cache/`。
   - 写 `.ticiou/.runtime/skillhub-lock.json`。
   - 渲染到 `.claude/skills/...` 或 `.github/...`。

### 工作流 B：切换用户 profile 并同步 SkillHub

```bash
ticiou use -u kaibin.xu --registry http://localhost:3000
```

流程：

1. 初始化目标项目。
2. 读取 `.ticiou/config.yaml`。
3. 安装已启用 platform adapter。
4. 收集 shared/profile 本地资源。
5. 读取 `profiles.users.kaibin.xu.skillhub.selections`。
6. 解析 token。
7. 如果有 token，调用 `whoami` 并比较 SkillHub 用户和 Ticiou profile。
8. 对 explicit selections 执行 `syncSelectedSkills`。
9. 把 cache 转成 managed files。
10. `writeManagedFiles` 写入平台目录并清理 stale files。
11. 写 current profile。

### 工作流 C：CI 检查模式

```bash
ticiou skill sync --frozen
```

流程：

1. 读取 config 和 lock。
2. 对 selection 调 remote resolve。
3. 检查 lock 版本/fingerprint 是否落后。
4. 检查 cache 是否存在。
5. 输出提示。
6. 不写任何文件。

适合：

- CI 确认 lock/cache 是否已经准备好。
- 团队稳定环境不允许自动升级远端 skills。

## Ticiou 与 SkillHub 的边界

Ticiou 不 shell 调 SkillHub CLI。Ticiou 只通过 SkillHub HTTP API 通信：

```text
Ticiou CLI
  -> Ticiou src/skillhub/client.ts
  -> SkillHub /api/cli/v1/*
  -> SkillHub Controller/App Service/Search/Domain
```

这样分层的好处：

- Ticiou 不依赖另一个 CLI 二进制。
- token 解析、lock/cache、manifest 渲染完全由 Ticiou 管理。
- SkillHub 保持 registry/API 服务边界。
- Windows/macOS/Linux 都走 Node 标准库路径处理和 HTTP fetch。

## 跨平台兼容性说明

本轮重点处理了这些跨平台点：

1. 路径边界判断使用 `path.relative` + `isAbsolute`，避免 Windows drive letter 或路径分隔符误判。
2. zip 解压使用 `resolve/relative/isAbsolute` 防 zip slip，兼容 Windows/macOS。
3. manifest 输出路径使用 POSIX 风格 relative path，平台 resource root 统一。
4. 凭据 chmod 在 Windows 跳过：

```ts
async function applyCredentialPermissions(path: string): Promise<void> {
  if (process.platform === "win32") {
    return;
  }

  await chmod(path, 0o600);
}
```

## 验证结果

Ticiou：

```bash
pnpm run typecheck
pnpm test
pnpm run build
```

结果：

```text
6 test files passed
47 tests passed
build passed
```

SkillHub：

```bash
./mvnw -pl skillhub-app -am test -DargLine="-XX:+EnableDynamicAgentLoading -Dnet.bytebuddy.experimental=true"
make typecheck-web
make test-frontend
```

结果：

```text
536 backend tests passed
web typecheck passed
180 frontend test files passed
602 frontend tests passed
```

运行中接口检查：

```bash
curl http://localhost:8080/actuator/health
curl "http://localhost:8080/api/cli/v1/skills/discover?size=1"
```

结果：

```text
health: UP
discover: HTTP 200
```

## 当前实现范围和后续空间

已完成：

- explicit skill selection 的 add/sync/use/install。
- discovery API 及 Ticiou `skill list --remote`。
- token 安全存储。
- lock/cache/render 一体化。
- OpenAPI schema 生成。

保留后续空间：

- selector 自动展开为 explicit skill selection。
- discovery 结果 N+1 查询优化为 query repository 批量组装。
- ETag/cache-control 等 HTTP 缓存策略。
- 彻底迁移并删除 legacy packaged profile skills。
