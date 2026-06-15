# SkillHub 配合 Ticiou 的实施计划

状态：实施计划草案

关联设计：[design.md](./design.md)

## 1. 当前能力评审

SkillHub 已经具备 Ticiou 集成所需的核心底座。

现有 CLI 接口：

```text
GET /api/cli/v1/auth/whoami
GET /api/cli/v1/skills/search
GET /api/cli/v1/skills/{namespace}/{slug}/resolve
GET /api/cli/v1/skills/{namespace}/{slug}/download
GET /api/cli/v1/skills/{namespace}/{slug}/versions/{version}/download
```

这些接口足够支持 Ticiou 的最小闭环：登录校验、显式添加某个 skill、解析版本、下载包。

主要缺口是 discovery。当前 `/api/cli/v1/skills/search` 只返回 `namespace`、`slug`、`latestVersion`、`summary`，不足以支持 Ticiou 的 selector、远端列表和同步状态判断。

## 2. 目标

新增一个面向 CLI 自动化的 discovery API，让 Ticiou 可以按 namespace、owner、label、visibility 查询可见 skills，并拿到 fingerprint。

SkillHub 仍然负责权限判断。Ticiou 只根据接口结果决定是否安装、更新、提示或保留本地缓存。

## 3. 不做的事

- 不提供“下载某用户全部 skills”的批量安装接口。
- 不让 Ticiou 绕过 SkillHub visibility 和 namespace 权限。
- 不把 private skill 的存在泄漏给匿名用户。
- 不要求 SkillHub CLI 成为 Ticiou 的运行时依赖。

## 4. 新增接口

接口：

```text
GET /api/cli/v1/skills/discover
```

参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `q` | string | 关键词 |
| `namespace` | string | namespace slug，例如 `global`、`emrois` |
| `owner` | string | 特殊值，当前只支持 `self` |
| `ownerId` | string | 指定 owner user id |
| `label` | repeated string | label slug，可重复 |
| `visibility` | string | `PUBLIC`、`NAMESPACE_ONLY`、`PRIVATE`，可选 |
| `page` | int | 默认 `0` |
| `size` | int | 默认 `20`，最大建议 `100` |
| `sort` | string | 默认 `newest` |

规则：

- `owner=self` 必须有认证 principal。
- 匿名请求只能看到 PUBLIC skills。
- 有 token 时返回该 token 用户可见的 skills。
- `owner` 和 `ownerId` 不能同时出现。
- `visibility=PRIVATE` 不表示越权，只在可见集合内继续过滤。

响应：

```json
{
  "items": [
    {
      "namespace": "emrois",
      "slug": "api-review",
      "displayName": "api-review",
      "summary": "Review API changes",
      "ownerId": "zhaoyanan",
      "ownerDisplayName": "Zhaoyanan",
      "visibility": "NAMESPACE_ONLY",
      "status": "ACTIVE",
      "publishedVersion": "1.3.0",
      "publishedVersionId": 42,
      "fingerprint": "sha256:def456",
      "labels": ["active", "ticiou"],
      "updatedAt": "2026-06-15T00:00:00Z"
    }
  ],
  "total": 1,
  "page": 0,
  "size": 20
}
```

`fingerprint` 必须来自当前可下载的 published version。没有 published version 的 skill 不应出现在匿名 discovery 中。

## 5. 文件改动清单

| 文件 | 动作 |
| --- | --- |
| `skillhub-app/src/main/java/.../controller/cli/CliSkillController.java` | 增加 `GET /discover` |
| `skillhub-app/src/main/java/.../service/cli/CliSkillAppService.java` | 增加 discovery app 方法，或拆出新 service |
| `skillhub-app/src/main/java/.../dto/cli/*` | 增加 request/response DTO |
| `skillhub-app/src/main/java/.../service/SkillSearchAppService.java` | 补充 owner/self、labels、visibility 组合查询能力 |
| `skillhub-domain/.../SkillQueryService.java` | 如需要，提供批量 fingerprint / version metadata 查询 |
| `skillhub-auth/.../RouteSecurityPolicyRegistry.java` | 放行 GET discovery，并允许 API token 访问 |
| `cli/src/clients/skillhub-client.ts` | 可选：给 SkillHub CLI client 增加 discover 方法 |

建议优先在 `CliSkillAppService` 中新增 discovery 方法。不要让 Ticiou 直接依赖 portal DTO。

## 6. 实施顺序

### 阶段 1：确认现有接口契约

任务：

- 确认 `whoami` 对匿名请求返回 401。
- 确认 `resolve` 返回 `version`、`versionId`、`fingerprint`、`downloadUrl`。
- 确认 download 对 PUBLIC 匿名可用，对不可访问 skill 返回 401/403/404。
- 确认 API token 能访问 CLI read endpoints。

测试：

- 复用 `CliAuthControllerTest`。
- 复用 `CliSkillControllerTest`。
- 复用 `RouteSecurityPolicyRegistryTest`。

验收：

- Ticiou 最小闭环不需要等待新接口。

### 阶段 2：定义 discovery DTO

任务：

- 新增 `CliDiscoverSkillResponse`。
- 新增 `CliDiscoverResponse`。
- 字段使用 CLI 友好的扁平结构。
- 时间使用 ISO instant。
- labels 返回 slug 列表。
- version 字段使用 published version，不使用 owner preview。

字段：

```java
namespace
slug
displayName
summary
ownerId
ownerDisplayName
visibility
status
publishedVersion
publishedVersionId
fingerprint
labels
updatedAt
```

验收：

- DTO 不暴露内部 entity。
- DTO 不包含下载 URL，下载仍走 resolve/download。

### 阶段 3：实现 controller

任务：

- 在 `CliSkillController` 增加 `@GetMapping("/discover")`。
- 接收 `q/namespace/owner/ownerId/label/visibility/page/size/sort`。
- 从 request attributes 读取 `userId` 和 `userNsRoles`。
- 将参数传给 app service。
- 增加 `@RateLimit(category = "search", authenticated = 60, anonymous = 20)`。

行为：

- `owner=self` 且无 `userId` 时返回 401。
- `owner=self` 时把 ownerId 解析为当前 `userId`。
- `ownerId` 是普通过滤，不代表授权。

验收：

- 匿名用户可以调用 discovery，但只看到 PUBLIC。
- 带 token 用户可以看到自己有权访问的 NAMESPACE_ONLY / PRIVATE。

### 阶段 4：实现 service 查询

任务：

- 复用 `SkillSearchAppService.search` 的搜索和 visibility scope。
- 为 discovery 增加 owner、label、namespace、visibility 组合过滤。
- 补齐 ownerId / ownerDisplayName。
- 批量查询 published version fingerprint。
- 批量查询 labels，避免 N+1。
- 过滤没有 published version 的匿名不可下载记录。

推荐实现：

- 新增 `CliSkillDiscoveryAppService`，内部依赖 `SkillSearchAppService` 和必要 repository。
- 或在 `CliSkillAppService` 中增加 `discover`，但不要让类继续膨胀太多。

注意：

- `SkillSummaryResponse` 当前没有 ownerId、labels、fingerprint。
- 如果直接复用 portal summary，需要再批量补字段。
- 不建议让 controller 循环调用 `resolve`，否则分页会产生 N+1。

验收：

- discovery 返回结果和 `resolve` 的 fingerprint 一致。
- 权限过滤由 SkillHub 统一完成。

### 阶段 5：更新路由和 token 策略

任务：

- 在 `RouteSecurityPolicyRegistry` 增加：

```java
RouteAuthorizationPolicy.permitAll(HttpMethod.GET, "/api/cli/v1/skills/discover")
ApiTokenPolicy.allow(HttpMethod.GET, "/api/cli/v1/skills/discover")
```

- 保持 publish/delete 仍需要 scope。
- 增加路由策略测试。

语义：

- 路由 permitAll 只是允许匿名进入 controller。
- 实际返回什么由 visibility filtering 决定。
- `owner=self` 是唯一需要 controller 主动要求认证的 discovery 场景。

验收：

- anonymous discovery 不被 security layer 拦截。
- API token 可以调用 discovery。
- 没有给 mutation endpoint 放宽权限。

### 阶段 6：增加 ETag

任务：

- 对 discovery response 计算 ETag。
- ETag 输入包含 query 参数、viewer userId、total、每个 item 的 namespace/slug/version/fingerprint/updatedAt。
- 支持 `If-None-Match` 返回 304。
- private 或 token 参与的响应设置 `Cache-Control: private`。
- 匿名 PUBLIC 响应可设置短时间公共缓存，或先统一 `private, max-age=0`。

建议：

- 第一版 Ticiou 可以只靠 fingerprint 去重。
- ETag 可以作为第二步优化，不阻塞 discovery 主流程。

验收：

- 同一 query 无变化时返回 304。
- 不同 token 用户不会共享 private ETag 结果。

### 阶段 7：补 download / resolve 缓存头

任务：

- resolve response 可附带 ETag。
- download response 可附带 `ETag` 和 `Last-Modified`。
- fingerprint 未变化时，Ticiou 不需要重新下载。

验收：

- 不改变现有 CLI install 行为。
- Ticiou 可以用 HTTP 条件请求减少下载。

### 阶段 8：可选更新 SkillHub CLI client

任务：

- 在 `cli/src/clients/skillhub-client.ts` 增加 `discover` 方法。
- 新增 TypeScript DTO。
- 可选新增 `skillhub search --namespace --owner --label`。

说明：

- 这不是 Ticiou 运行时依赖。
- 这个改动只让 SkillHub CLI 自己也能验证 discovery endpoint。

验收：

- 不影响现有 `skillhub install/publish/search`。

## 7. 权限矩阵

| 场景 | 匿名 | 普通成员 | owner | namespace admin |
| --- | --- | --- | --- | --- |
| PUBLIC | 可见 | 可见 | 可见 | 可见 |
| NAMESPACE_ONLY | 不可见 | 成员 namespace 可见 | 成员 namespace 可见 | 可见 |
| PRIVATE | 不可见 | 不可见 | 可见 | 可见 |
| hidden | 不可见 | 不可见 | owner 可见 | admin 可见 |
| 未发布 | 不可见 | 不可见 | owner preview 可见性按现有规则 | admin 按现有规则 |

discovery 不应返回调用者不可访问的记录。对于不可访问记录，优先“不可见”，不要在列表中暴露 forbidden。

`resolve/download` 可以继续对显式请求返回 401/403/404。Ticiou 会把这些状态映射为 `forbidden` 或 `missing_remote`。

## 8. Ticiou 调用方式

远端列表：

```http
GET /api/cli/v1/skills/discover?namespace=emrois&owner=self&label=active&page=0&size=100
Authorization: Bearer <token>
```

同步已选 skill：

```http
GET /api/cli/v1/skills/emrois/api-review/resolve
Authorization: Bearer <token>
```

下载指定版本：

```http
GET /api/cli/v1/skills/emrois/api-review/versions/1.3.0/download
Authorization: Bearer <token>
```

匿名 PUBLIC：

```http
GET /api/cli/v1/skills/discover?namespace=global&label=baseline
```

## 9. 测试计划

Controller tests：

- anonymous discovery 返回 PUBLIC。
- `owner=self` anonymous 返回 401。
- authenticated `owner=self` 传给 service 的 ownerId 是 principal userId。
- label、namespace、ownerId、page、size、sort 参数能传递。
- API token 可访问 discovery。

Service tests：

- PUBLIC 匿名可见。
- NAMESPACE_ONLY 仅 namespace 成员可见。
- PRIVATE 仅 owner/admin 可见。
- ownerId filter 生效。
- label 多值过滤生效。
- fingerprint 来自 published version。
- 没有 published version 的匿名结果被过滤。

Route policy tests：

- `GET /api/cli/v1/skills/discover` permitAll。
- API token allow discovery。
- publish/delete scope 不变。

ETag tests：

- 相同 query 和相同结果返回 304。
- fingerprint 变化后返回 200。
- 不同 userId 的 ETag 不复用。

## 10. 验收标准

最小验收：

- Ticiou 可通过 `resolve/download` 安装显式选择的 skill。
- `whoami` 可用于校验 token 身份。
- 不需要用户安装 SkillHub CLI。

完整验收：

- `discover` 支持 namespace、owner/self、ownerId、label、pagination。
- discovery response 含 fingerprint。
- anonymous / token 权限过滤正确。
- Ticiou 可以实现 `skill list --remote` 和 selector 增量同步。

## 11. 风险和处理

| 风险 | 处理 |
| --- | --- |
| discovery 复用 portal response 字段不足 | 新增 CLI DTO，批量补 owner/labels/fingerprint |
| owner=self 匿名泄漏语义 | 明确返回 401，不返回空列表伪装 |
| N+1 resolve 导致列表慢 | service 批量查 published version metadata |
| private 数据被缓存共享 | ETag 输入包含 viewer，Cache-Control 用 private |
| API token 误获写权限 | 只 allow GET discovery，publish/delete policy 不变 |

## 12. 建议交付顺序

1. 保持现有 `whoami/resolve/download` 稳定。
2. 增加 discovery DTO 和 controller。
3. 增加 service 查询和 fingerprint/labels 补全。
4. 更新路由和 API token policy。
5. 补 controller/service/policy 测试。
6. 增加 ETag。
7. 可选更新 SkillHub CLI client。

Ticiou 可以先基于第 1 步启动集成。`skill list --remote` 和 selector 同步等待第 2 到第 5 步完成后再打开。
