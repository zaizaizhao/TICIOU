# Ticiou 与 SkillHub 同步设计

状态：设计提案

## 1. 背景

SkillHub 已经承担 skill 的注册中心职责：发布、版本、命名空间、可见性、权限、搜索、解析和下载。Ticiou 当前承担 profile 编译职责：把团队共享资源和用户 profile 渲染为 Claude / Copilot 的项目配置。

新的目标是让 Ticiou 能够从 SkillHub 拉取某个 profile 需要的 skills，并与现有 hooks、agents、commands、prompts 一起装配到目标项目中。

关键约束：

- Ticiou 的 `user` 不是认证身份本身，只是 profile 名。
- SkillHub token 决定实际能访问哪些 remote skills。
- 不应默认安装当前用户能看到或上传的全部 skills。
- `ticiou use` 应该稳定、可重复、可回滚。
- 新增 skill、删除 skill、版本更新需要分开处理。

## 2. 术语

| 术语 | 含义 |
| --- | --- |
| SkillHub user | SkillHub 中的登录用户，由 token / session 决定 |
| Namespace | SkillHub skill 仓库，例如 `global`、`emrois` |
| Ticiou profile | Ticiou 的配置档，例如 `zhaoyanan` |
| Selection | Ticiou profile 明确选择启用的 SkillHub skills |
| Selector | 用 namespace、owner、label 等条件描述一组候选 skills |
| Lock | 本地记录已安装 skill 的 namespace、slug、version、fingerprint |
| Cache | 本地保留的已下载 skill 内容 |

## 3. 推荐职责边界

### 3.1 SkillHub 负责

- Skill 包发布和审核。
- 命名空间和成员权限。
- PUBLIC / NAMESPACE_ONLY / PRIVATE 可见性。
- 版本解析、fingerprint、下载。
- token 认证与权限判断。

### 3.2 Ticiou 负责

- 读取 profile。
- 选择需要启用的 SkillHub skills。
- 将 skills 安装到当前目标 agent 的 skills 目录。
- 渲染 hooks、agents、commands、prompts。
- 维护 `.ticiou/.runtime/manifest.json` 和 skill lock。
- 决定何时提示、同步、保留或移除本地缓存。

### 3.3 不建议的边界

不建议让 `ticiou use -u zhaoyanan` 默认安装 zhaoyanan 上传的全部 skills。原因：

- 上传者名下可能包含实验、草稿、历史或不适合当前项目的 skills。
- 用户可能能访问多个 namespace，自动全量安装会污染上下文。
- private skill 的安装受 token 权限影响，默认全量容易造成不可预测失败。
- profile 应该是明确的装配清单，而不是权限可见范围的镜像。

## 4. Namespace 建模建议

推荐使用以下模型：

| Namespace | 用途 | 典型可见性 |
| --- | --- | --- |
| `global` | 组织级公共基础能力 | PUBLIC |
| `emrois` | emrois 团队 skill 仓库 | NAMESPACE_ONLY |
| `emrois` + owner=zhaoyanan | zhaoyanan 维护的团队内个人能力 | NAMESPACE_ONLY 或 PRIVATE |

Ticiou profile `zhaoyanan` 可以引用这些来源，但不等于自动加载全部来源：

```yaml
profiles:
  zhaoyanan:
    skillhub:
      registry: http://localhost:3000
      selectors:
        - namespace: global
          label: baseline
          policy: auto
        - namespace: emrois
          label: team-shared
          policy: auto
        - namespace: emrois
          owner: self
          label: active
          policy: prompt-new
```

建议通过 label 控制哪些 skills 可以被 Ticiou 装配，例如：

- `baseline`：组织级默认能力。
- `team-shared`：团队共享能力。
- `active`：用户当前希望启用的个人能力。
- `ticiou`：明确允许被 Ticiou 同步。

## 5. Token 与身份

Ticiou 不集成 `skillhub` CLI 二进制，但可以借鉴其 credential resolver、HTTP client、resolve/download 和 install 逻辑，在 Ticiou 内部作为独立模块维护。

建议目录：

```text
src/skillhub/
  client.ts              # HTTP client: whoami, discover, resolve, download
  credentials.ts         # token 解析、交互输入、保存、删除
  registry.ts            # registry 解析和归一化
  install.ts             # 解压 skill 到目标 agent skills 目录
  types.ts               # DTO 和本地模型
```

Ticiou 不保存明文 token 到项目文件。token 来源按优先级：

1. `--token` 参数，仅当前命令使用。
2. `SKILLHUB_TOKEN` 环境变量。
3. Ticiou 自己的本机凭据，例如 `~/.ticiou/skillhub-credentials.json`。
4. 交互式粘贴 token，可选择仅本次使用或保存到本机凭据。
5. 后续可扩展系统 keychain。

不建议默认读取项目目录内的 token，也不建议把 token 写入 `.ticiou/config.yaml`、profile、manifest 或 lock。

### 5.1 本机凭据文件

建议 Ticiou 使用自己的用户级凭据文件：

```text
~/.ticiou/skillhub-credentials.json
```

示例：

```json
{
  "tokens": {
    "http://localhost:3000": {
      "token": "sk_xxx",
      "savedAt": "2026-06-15T00:00:00.000Z",
      "lastVerifiedUser": "zhaoyanan"
    }
  }
}
```

要求：

- Linux / macOS 上文件权限设置为 `0600`。
- token 只按 normalized registry 作为 key 保存。
- `http://localhost:3000` 和 `http://localhost:8080` 是两个不同 registry key。
- 终端输出、日志、错误信息不得打印 token。
- 后续如果支持 keychain，可把 JSON 文件作为 fallback。

### 5.2 Token resolver

Ticiou 每次发起 SkillHub 请求前解析 token：

```text
resolveToken(registry, commandOptions, env):
  if commandOptions.token exists:
    return { token, source: "flag", persistent: false }

  if env.SKILLHUB_TOKEN exists:
    return { token, source: "env", persistent: false }

  if ~/.ticiou/skillhub-credentials.json has token for registry:
    return { token, source: "ticiou-store", persistent: true }

  if interactive and command allows prompt:
    ask user to paste token
    optionally save to ~/.ticiou/skillhub-credentials.json
    return { token, source: "prompt", persistent: userChoice }

  return { token: undefined, source: "anonymous", persistent: false }
```

HTTP client 只在内存中注入 token：

```http
Authorization: Bearer sk_xxx
```

无 token 时：

- PUBLIC skills 可以匿名 discovery / resolve / download。
- NAMESPACE_ONLY / PRIVATE skills 可能返回 401 / 403 或不可见。
- Ticiou 应提示 `No SkillHub token found, continuing with public skills only.`，除非命令明确要求认证。

### 5.3 登录命令

建议新增：

```bash
ticiou skillhub login --registry http://localhost:3000
ticiou skillhub whoami --registry http://localhost:3000
ticiou skillhub logout --registry http://localhost:3000
```

`login` 交互：

```text
SkillHub registry [http://localhost:3000]:
Paste SkillHub token: ********
Verify token now? [Y/n]
Save token locally? [Y/n]

Logged in as zhaoyanan
Saved token for http://localhost:3000
```

输入 token 时必须隐藏回显。若校验失败，不保存 token，除非用户显式要求保存未验证 token；默认不提供保存未验证 token 的路径。

`whoami` 行为：

```text
Registry: http://localhost:3000
Token source: ~/.ticiou/skillhub-credentials.json
User: zhaoyanan
```

`logout` 行为：

```text
Removed saved SkillHub token for http://localhost:3000
```

### 5.4 use / sync 中的临时注入

`use` 和 `sync` 可以支持：

```bash
ticiou use -u zhaoyanan --registry http://localhost:3000 --token sk_xxx
ticiou use -u zhaoyanan --registry http://localhost:3000 --ask-token
ticiou use -u zhaoyanan --registry http://localhost:3000 --anonymous
```

参数语义：

| 参数 | 行为 |
| --- | --- |
| `--token` | 本次命令使用，不保存；不建议长期使用，可能进入 shell history |
| `--ask-token` | 即使没有保存 token，也允许交互粘贴 |
| `--anonymous` | 禁用 token resolver，只访问 PUBLIC skills |
| `--registry` | 选择 registry，也是凭据文件里的 token key |

当交互式命令找不到 token 时：

```text
SkillHub token not found for http://localhost:3000.

Options:
  1. Paste token for this run
  2. Paste and save locally
  3. Continue anonymously
  4. Cancel
Choose [1]:
```

非交互环境不能要求用户粘贴 token。没有 token 时，命令应匿名继续或失败，具体取决于命令语义：

- `ticiou skill list --remote`：可匿名继续，只显示 PUBLIC skills。
- `ticiou use`：如果 profile 只依赖 PUBLIC skills，可继续；如果包含 private / namespace-only selections，提示认证缺失并失败。
- `ticiou skill sync --frozen`：认证缺失导致 selection 无法校验时失败。

`ticiou use -u zhaoyanan` 应先执行身份校验：

```text
GET /api/cli/v1/auth/whoami
```

如果 profile user 是 `zhaoyanan`，但 token 对应用户不是 `zhaoyanan`：

- PUBLIC skills 可继续。
- NAMESPACE_ONLY skills 取决于 token 用户是否是 namespace 成员。
- PRIVATE skills 只有 owner 或 namespace admin/owner 可以访问。
- Ticiou 应显示明确提示，而不是假设 profile user 就是远端 owner。

### 5.5 与 SkillHub CLI 的关系

Ticiou 不需要依赖 `npx @astron-team/skillhub` 执行安装。建议只借鉴或复用以下实现思路：

- registry normalization。
- token resolver。
- credentials file 权限处理。
- SkillHub API client。
- resolve/download 错误处理。
- zip 解压和安装 metadata。

长期更好的做法是把 SkillHub CLI 的 client / install 逻辑抽成可复用包；在此之前，Ticiou 可以维护一份精简实现。

## 6. 命令设计

### 6.0 SkillHub 凭据管理

```bash
ticiou skillhub login --registry http://localhost:3000
ticiou skillhub whoami --registry http://localhost:3000
ticiou skillhub logout --registry http://localhost:3000
```

这些命令只管理用户本机凭据，不修改项目 profile 和 lock。

### 6.1 Profile 激活

```bash
ticiou use -u zhaoyanan
```

语义：

- 初始化 Ticiou project state。
- 安装已启用 platform adapter。
- 按当前 profile 的 selection 和 lock 安装缺失 skills。
- 渲染 hooks、agents、commands、prompts。
- 后台检查 remote 更新，但默认不阻塞、不自动加入新 skills。

`use` 不应该默认做这些事：

- 不默认安装当前用户上传的全部 skills。
- 不默认加入远端新增 skills。
- 不默认删除本地缓存。
- 不在未配置 auto refresh 时静默升级已锁定版本。

### 6.2 查看远端候选

```bash
ticiou skill list --remote
ticiou skill list --remote --namespace emrois
ticiou skill list --remote --namespace emrois --owner self
ticiou skill list --remote --label active
```

语义：

- 根据当前 token 查询可见 skills。
- 展示是否已启用、是否已安装、远端版本、本地版本、可见性。

示例输出：

```text
SkillHub user: zhaoyanan
Registry: http://localhost:3000

Available skills in emrois:

  Status    Skill                     Remote    Local     Visibility
  enabled   emrois/api-review         1.3.0     1.2.0     NAMESPACE_ONLY
  new       emrois/kafka-debug        0.1.0     -         PRIVATE
  disabled  emrois/sql-review         1.0.0     -         PUBLIC
```

### 6.3 加入 profile

```bash
ticiou skill add emrois/api-review
ticiou skill add emrois/kafka-debug --version 0.1.0
ticiou skill add --namespace emrois --owner self --label active
```

语义：

- 将 skill 或 selector 写入当前 profile 的 selection。
- 解析版本并写入 lock。
- 下载并安装 skill。
- 更新 Ticiou manifest。

### 6.4 移出 profile

```bash
ticiou skill remove emrois/api-review
```

交互：

```text
Remove emrois/api-review from profile zhaoyanan?
  1. Disable only, keep local cache
  2. Remove generated files and cache
  3. Cancel
```

默认建议：disable only。这样能避免误删 private skill 的本地副本。

### 6.5 手动同步

```bash
ticiou skill sync
ticiou skill sync --namespace emrois
ticiou skill sync emrois/api-review
```

语义：

- 只同步已启用 selections。
- 对比 lock 中的 `version` / `fingerprint` 与远端解析结果。
- 按策略处理更新、新增、删除或不可访问。

默认交互：

```text
Checking SkillHub updates...

Updates:
  emrois/api-review        1.2.0 -> 1.3.0

New matching skills:
  emrois/kafka-debug       0.1.0

Missing or inaccessible:
  emrois/old-release-check local 0.9.0

Apply updates to enabled skills? [Y/n]
Load new matching skills? [y/N]
For missing skills: [keep cache / disable / remove]
```

默认建议：

- 修改 skill：提示后更新，或在 `auto_refresh=true` 时静默更新。
- 新增 skill：只提示，不默认加入。
- 删除或不可访问：提示，默认保留本地缓存但标记 stale。

### 6.6 自动刷新

配置：

```yaml
profiles:
  zhaoyanan:
    skillhub:
      auto_refresh: false
      background_check: true
      update_policy: prompt
      new_skill_policy: prompt
      deleted_skill_policy: keep-cache
```

可选策略：

| 策略 | 行为 |
| --- | --- |
| `auto_refresh=false` | `use` 不更新已锁定 skill，只做后台检查 |
| `auto_refresh=true` | `use` 可静默更新已启用 skill |
| `new_skill_policy=prompt` | 发现新增 skill 时提示 |
| `new_skill_policy=ignore` | 发现新增 skill 时只记录，不提示 |
| `new_skill_policy=auto-add` | 自动加入 selector 命中的新增 skill，仅建议团队基线使用 |
| `deleted_skill_policy=keep-cache` | 删除或不可访问时保留本地缓存 |
| `deleted_skill_policy=disable` | 标记 disabled，不再注入 agent |
| `deleted_skill_policy=remove` | 删除本地生成文件和缓存 |

## 7. 同步状态机

每个 remote skill 在本地有以下状态：

| 状态 | 含义 |
| --- | --- |
| `selected` | profile 已选择该 skill |
| `installed` | 本地已有对应版本内容 |
| `update_available` | 远端 fingerprint 或版本变化 |
| `new_remote` | selector 命中但本地未选择 |
| `missing_remote` | lock 中存在但远端不存在 |
| `forbidden` | 远端存在但当前 token 无权访问 |
| `stale_cache` | 本地缓存保留，但不确定远端状态 |
| `disabled` | profile 不再启用，但本地可能保留缓存 |

处理矩阵：

| 远端状态 | 默认行为 | 可选行为 |
| --- | --- | --- |
| 已选 skill 有新版本 | 提示更新 | auto_refresh 时静默更新 |
| selector 命中新 skill | 提示加入 | auto-add 或 ignore |
| 已选 skill 被删除 | 提示保留缓存 | disable 或 remove |
| 已选 skill 变为 forbidden | 保留缓存并提示 token/权限 | remove 或重新登录 |
| fingerprint 未变化 | 不下载 | 无 |

## 8. Lock 文件

建议新增：

```text
.ticiou/.runtime/skillhub-lock.json
```

示例：

```json
{
  "version": 1,
  "profile": "zhaoyanan",
  "registry": "http://localhost:3000",
  "generatedAt": "2026-06-15T00:00:00.000Z",
  "skills": [
    {
      "namespace": "emrois",
      "slug": "api-review",
      "selector": {
        "namespace": "emrois",
        "owner": "self",
        "label": "active"
      },
      "version": "1.2.0",
      "fingerprint": "sha256:abc123",
      "visibility": "NAMESPACE_ONLY",
      "installTargets": [
        {
          "agent": "codex",
          "path": ".codex/skills/api-review"
        }
      ],
      "status": "installed",
      "updatedAt": "2026-06-15T00:00:00.000Z"
    }
  ]
}
```

lock 文件用于：

- 保证 `ticiou use` 可重复。
- 避免每次启动都重新下载。
- 对比远端 fingerprint。
- 在远端删除或权限变化时保留本地上下文。

## 9. SkillHub API 交互

### 9.1 当前可用接口

SkillHub CLI 现有 install 流程依赖：

```text
GET /api/cli/v1/skills/{namespace}/{slug}/resolve?version={version}
GET /api/cli/v1/skills/{namespace}/{slug}/versions/{version}/download
```

`resolve` 返回 version、versionId、fingerprint、downloadUrl。Ticiou 可直接使用该 fingerprint 做更新检测。

当前 portal 侧已有：

```text
GET /api/v1/me/skills
GET /api/web/skills?ownerId=...
GET /api/v1/namespaces/{namespace}/skills
```

这些可用于 discovery，但面向 Ticiou 的 CLI 批量同步最好补充专门 API。

### 9.2 建议新增接口

```text
GET /api/cli/v1/skills/discover?namespace=emrois&owner=self&label=active&page=0&size=100
```

返回：

```json
{
  "items": [
    {
      "namespace": "emrois",
      "slug": "api-review",
      "displayName": "api-review",
      "ownerId": "zhaoyanan",
      "visibility": "NAMESPACE_ONLY",
      "publishedVersion": "1.3.0",
      "fingerprint": "sha256:def456",
      "labels": ["active", "ticiou"]
    }
  ],
  "total": 1
}
```

### 9.3 ETag / Last-Modified

推荐两层优化：

1. 发现列表接口返回 `ETag`，Ticiou 下次带 `If-None-Match`。
2. 下载接口返回 `ETag` / `Last-Modified`，Ticiou 在 fingerprint 未变化时不下载。

在 SkillHub 未实现 ETag 前，Ticiou 可先使用 `resolve.fingerprint` 避免重复下载。

## 10. 命令流程

### 10.1 首次使用

```bash
ticiou use -u zhaoyanan
```

流程：

1. 读取 `.ticiou/config.yaml`。
2. 检查 SkillHub registry。
3. 读取 token，调用 `whoami`。
4. 如果 profile 没有 selection，进入引导：
   - 选择 namespace：`global`、`emrois`。
   - 选择来源：team shared、owner self、label active。
   - 勾选要启用的 skills。
5. 写入 selection。
6. resolve 每个 skill。
7. 下载并安装。
8. 写 lock 和 manifest。
9. 渲染 Claude / Copilot 配置。

### 10.2 后续使用

```bash
ticiou use -u zhaoyanan
```

流程：

1. 读取 selection 和 lock。
2. 检查本地已选 skills 是否存在。
3. 缺失则按 lock 版本补装。
4. 渲染平台配置。
5. 后台检查 remote metadata。
6. 如果有更新，显示轻提示或写入 pending 状态。

### 10.3 手动同步

```bash
ticiou skill sync --namespace emrois
```

流程：

1. 读取当前 profile。
2. 查询 selection 命中的 remote skills。
3. 对比 lock。
4. 分组为 updates、new、missing、forbidden。
5. 按策略交互。
6. 下载更新后的 skills。
7. 更新 lock、manifest、agent skill 目录。

## 11. 安全设计

- token 不进入 profile、manifest、lock。
- 终端输出不打印 token。
- private skill 本地缓存默认不随 `remove` 立即删除，除非用户确认。
- 当 profile user 与 SkillHub token user 不一致时，Ticiou 必须提示。
- `--frozen` 模式下不修改 selection 和 lock，适合 CI 或团队稳定环境。

## 12. 实现建议

阶段一：

- 增加 `src/skillhub/` 模块：client、credentials、registry、install、types。
- 增加 `ticiou skillhub login/whoami/logout`。
- 增加 `ticiou skill list --remote`。
- 增加 `ticiou skill add/remove`。
- 增加 `skillhub-lock.json`。
- 使用 SkillHub 现有 resolve/download 接口。

阶段二：

- 增加 `ticiou skill sync`。
- 支持更新、新增、删除、forbidden 状态。
- 使用 fingerprint 做差量检测。

阶段三：

- SkillHub 增加 CLI discovery API。
- 支持 ETag / Last-Modified。
- 支持 background check 和 pending notification。

阶段四：

- 支持团队模板 selector。
- 支持 auto-add baseline。
- 支持 keychain token backend。
