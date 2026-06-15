# Ticiou SkillHub 集成实施计划

状态：实施计划草案

关联设计：[design.md](./design.md)

## 1. 评审结论

当前 `design.md` 的职责边界是合理的：SkillHub 负责 skill 注册、权限、版本和下载；Ticiou 负责 profile 编排、agent 目录渲染和本地 lock。

需要在实施时补强三点。

第一，Ticiou 现有 packaged skills 路径要先收敛，再接 SkillHub。不能直接把 `profiles/**/skills` 删除，否则现有 `use/setup` 集成测试会立刻失败。

第二，`config.yaml` 当前是手写浅层解析器。selection、selector、sync policy 是嵌套结构，应先引入结构化 YAML 解析或拆成独立 JSON 配置。

第三，SkillHub 当前 CLI `search` 字段太少。Ticiou 第一版可用 `resolve/download`，但完整同步需要 SkillHub 增加 discovery API。

## 2. 实施原则

- `ticiou use -u <user>` 不默认安装该用户上传的全部 skills。
- Ticiou profile user 不是 SkillHub 登录身份。
- token 不写入项目目录、profile、manifest、lock。
- 已选择 skills 的更新和新增 skills 的加入分开处理。
- 删除或 forbidden 的 private skill 默认保留本地缓存。
- 每一阶段都要保持 `npm test` 和 `npm run typecheck` 可通过。

## 3. 目标流程

首次配置：

```bash
ticiou skillhub login --registry http://localhost:3000
ticiou skill list --remote --namespace emrois --owner self --label active
ticiou skill add emrois/api-review
ticiou use -u zhaoyanan
```

日常使用：

```bash
ticiou use -u zhaoyanan
ticiou skill sync
```

`use` 负责按 selection 和 lock 恢复当前 profile。`sync` 负责显式检查远端更新、新增、删除和权限变化。

## 4. 模块去留

| 模块 | 处理 | 说明 |
| --- | --- | --- |
| `src/platforms/*` | 保留 | Claude / Copilot adapter 仍是 Ticiou 核心能力 |
| `src/infra/manifest.ts` | 修改 | 增加 `skillhub` source，继续负责安全写入和 stale 清理 |
| `src/project/config.ts` | 重构 | 使用结构化解析，加入 skillhub selection 配置 |
| `src/rendering/resources.ts` | 修改 | 不再从 packaged profile 默认收集 skills |
| `src/rendering/skill-frontmatter.ts` | 拆分 | command frontmatter 保留，local skill name 归一化迁入 legacy 模块 |
| `src/rendering/claude-local-plugin.ts` | 先保留，后废弃 | 只服务 legacy profile skills；SkillHub skills 第一版直接写 agent skills 目录 |
| `profiles/shared/hooks` 等非 skill 资源 | 保留 | hooks、agents、commands、prompts 仍由 Ticiou 管理 |
| `profiles/shared/skills/*` | 迁移后删除 | 当前发现 `azure-devops`，应迁移到 SkillHub 后删除 |
| `profiles/users/*/skills/*` | 迁移后删除 | 如果存在用户 packaged skills，迁移到 SkillHub 后删除 |

## 5. 新增目录

```text
src/skillhub/
  client.ts
  credentials.ts
  registry.ts
  install.ts
  selection.ts
  lock.ts
  sync.ts
  types.ts

src/app/commands/skillhub/
  login.ts
  whoami.ts
  logout.ts

src/app/commands/skill/
  list.ts
  add.ts
  remove.ts
  sync.ts
```

这些模块只属于 Ticiou。Ticiou 不调用 `npx @astron-team/skillhub`，只复用它的实现思路。

## 6. 数据文件

项目内文件：

```text
.ticiou/config.yaml
.ticiou/.runtime/manifest.json
.ticiou/.runtime/skillhub-lock.json
.ticiou/.runtime/skillhub-cache/
```

本机用户文件：

```text
~/.ticiou/skillhub-credentials.json
```

`config.yaml` 记录 selection 和策略。`skillhub-lock.json` 记录已解析版本、fingerprint、状态和安装目标。credentials 只保存在用户级目录。

## 7. 配置结构

建议把 profile selection 放在 `.ticiou/config.yaml` 中：

```yaml
profiles:
  default_user: zhaoyanan
  users:
    zhaoyanan:
      skillhub:
        registry: http://localhost:3000
        auto_refresh: false
        background_check: true
        update_policy: prompt
        new_skill_policy: prompt
        deleted_skill_policy: keep-cache
        selections:
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
          - namespace: emrois
            slug: api-review
            version: 1.2.0
            policy: pinned
```

落地时不要继续扩展当前正则解析器。应增加 `yaml` 依赖，并为 `TiciouConfig` 写显式 normalize / validate。

## 8. 实施顺序

### 阶段 0：建立基线

任务：

- 运行现有 `npm test` 和 `npm run typecheck`，记录当前失败或通过状态。
- 标记现有 tests 中依赖 packaged skills 的断言。
- 给 `resources.ts`、`claude-local-plugin.ts`、`manifest.ts` 增加小范围单测缺口清单。

验收：

- 明确哪些测试会因移除 local skills 而需要改写。
- 没有功能改动。

### 阶段 1：重构配置解析

任务：

- 增加 `yaml` 依赖。
- 用 YAML parser 替换 `src/project/config.ts` 的手写解析。
- 保持现有浅层配置读写格式兼容。
- 增加 `profiles.users.<user>.skillhub` 类型。
- 增加 selection、sync policy、registry 的默认值。
- 对未知字段选择宽容读取，但序列化时只写受支持字段。

测试：

- 读取旧版 `config.yaml`。
- 写出旧版字段不丢失关键语义。
- 读取含 skillhub selection 的新版配置。
- 非法 policy、非法 registry、空 namespace 给出清晰错误。

验收：

- 现有 `init/setup/use/status` 行为不变。
- 新配置结构可以被稳定解析和序列化。

### 阶段 2：拆开 profile resources 与 packaged skills

任务：

- 将 `collectManagedResourceFiles` 拆为非 skill 资源收集和 skill 资源收集。
- 默认只从 packaged profiles 收集 `hooks/agents/commands/prompts`。
- 增加 legacy 开关，例如 `render.legacy_packaged_skills: true`，短期兼容测试和迁移。
- 将 `ManagedSource` 扩展为 `shared | profile | adapter | skillhub | legacy-skill`。
- 把 `normalizeSkillFrontmatterName` 移到 legacy skill 渲染模块。
- `claude-local-plugin.ts` 只在 legacy packaged skills 开启时运行。

测试：

- legacy 开启时旧 packaged skill 断言仍通过。
- legacy 关闭时不再生成 `profiles/**/skills` 对应文件。
- hooks、agents、commands、prompts 仍正常渲染。
- manifest 能清理从 legacy skills 移除后的 stale 文件。

验收：

- Ticiou 已具备从另一个来源注入 skills 的位置。
- 还没有要求 SkillHub 可用。

### 阶段 3：新增 SkillHub 基础模块

任务：

- `registry.ts`：归一化 registry，去掉尾部 `/`，校验 URL。
- `credentials.ts`：实现 token resolver。
- `client.ts`：实现 `whoami/search/resolve/download`。
- `install.ts`：解压 zip 到本地 cache，并转换为 `ManagedFile[]`。
- `types.ts`：定义 DTO、本地 selection、lock、sync state。
- 所有错误信息必须隐藏 token。

token 优先级：

1. `--token`
2. `SKILLHUB_TOKEN`
3. `~/.ticiou/skillhub-credentials.json`
4. `--ask-token` 交互粘贴
5. anonymous

测试：

- registry normalization。
- token resolver 优先级。
- credentials 文件权限为 `0600`。
- fetch stub 覆盖 401、403、404、5xx。
- download 重定向和普通 response 都能处理。

验收：

- 可以不用 SkillHub CLI 进程完成 whoami、resolve、download。
- 无 token 时 PUBLIC skill 可匿名读取。

### 阶段 4：实现 SkillHub 凭据命令

任务：

- 增加 `ticiou skillhub login`。
- 增加 `ticiou skillhub whoami`。
- 增加 `ticiou skillhub logout`。
- 给 root program 注册 `skillhub` 子命令。
- 输出 token source，但不输出 token 本身。
- `login` 默认校验 token，校验失败不保存。

交互：

```text
SkillHub registry [http://localhost:3000]:
Paste SkillHub token: ********
Verify token now? [Y/n]
Save token locally? [Y/n]

Logged in as zhaoyanan
Saved token for http://localhost:3000
```

测试：

- login 保存 token。
- whoami 显示用户和 registry。
- logout 删除对应 registry token。
- 非交互环境下没有 token 时不阻塞。

验收：

- 用户可以先登录 SkillHub，再执行 skill 管理命令。

### 阶段 5：实现 lock 和 cache

任务：

- 新增 `.ticiou/.runtime/skillhub-lock.json`。
- 新增 `.ticiou/.runtime/skillhub-cache/<registry-hash>/<namespace>/<slug>/<version>/`。
- lock 记录 registry、profile、selector、version、fingerprint、visibility、status、installTargets。
- cache 只存 skill 包展开后的内容，不存 token。
- lock 写入必须是原子写入。

状态：

| 状态 | 含义 |
| --- | --- |
| `installed` | 已下载并注入 manifest |
| `update_available` | 远端 fingerprint 或 version 变化 |
| `new_remote` | selector 命中但未加入 |
| `missing_remote` | lock 中存在但远端不存在 |
| `forbidden` | 当前 token 无权访问 |
| `stale_cache` | 本地保留，但远端状态不确定 |
| `disabled` | profile 不启用 |

测试：

- lock 读写和 schema 校验。
- fingerprint 未变化不重复下载。
- lock 中 registry/profile 不匹配时报错。
- forbidden 不删除 cache。

验收：

- `use` 和 `sync` 可以基于 lock 做可重复安装。

### 阶段 6：把 `use` 接入 SkillHub

任务：

- 给 `ticiou use` 增加参数：`--registry`、`--token`、`--ask-token`、`--anonymous`、`--frozen`。
- `useProfile` 读取当前 profile 的 skillhub selection。
- 对已锁定 skills：如果本地文件缺失，按 lock 版本补装。
- 对未锁定 selections：resolve、download、写 lock。
- `auto_refresh=false` 时不升级已有 lock。
- `--frozen` 时禁止修改 selection 和 lock。
- profile user 与 SkillHub token user 不一致时显示提示。

默认行为：

- 没有 selection：只渲染非 skill profile 资源，并提示使用 `ticiou skill add`。
- selection 只含 PUBLIC：无 token 可继续。
- selection 含 private / namespace-only：无 token 时失败并提示 login。

测试：

- use 无 selection 不访问远端。
- use 安装一个 locked PUBLIC skill。
- use 在无 token 下访问 private selection 失败。
- use 在 `--frozen` 下不写 lock。
- use 仍渲染 hooks、agents、commands、prompts。

验收：

- `ticiou use -u zhaoyanan` 可以稳定恢复已选择 SkillHub skills。

### 阶段 7：实现 `ticiou skill list/add/remove`

任务：

- `skill list --remote`：展示远端候选。
- `skill add <namespace>/<slug>`：加入当前 profile selection，resolve，download，写 lock。
- `skill add --namespace emrois --owner self --label active`：加入 selector。
- `skill remove <namespace>/<slug>`：从 selection 禁用或移除，并按用户选择处理 cache。
- 给 root program 注册 `skill` 子命令。

输出字段：

```text
Status    Skill                 Remote    Local    Visibility
enabled   emrois/api-review     1.3.0     1.2.0    NAMESPACE_ONLY
new       emrois/kafka-debug    0.1.0     -        PRIVATE
disabled  global/sql-review     1.0.0     -        PUBLIC
```

测试：

- list 匿名只显示 PUBLIC。
- list 带 token 显示 token 可见范围。
- add 单个 skill 写 selection 和 lock。
- add selector 不默认加入所有新增 skill，除非 policy 允许。
- remove 默认 disable only。

验收：

- 用户可以显式选择 profile 要启用哪些 remote skills。

### 阶段 8：实现 `ticiou skill sync`

任务：

- 对 selected skills 调用 resolve，比对 fingerprint。
- 对 selector 调用 discovery/search，识别 new matching skills。
- 分组输出 updates、new、missing、forbidden。
- 按策略执行更新、提示、保留 cache 或 disable。
- 支持 `--namespace`、`--all`、`--frozen`、`--yes`。

默认策略：

| 场景 | 默认行为 |
| --- | --- |
| 已选 skill 修改 | 提示更新 |
| `auto_refresh=true` | 静默更新已选 skill |
| selector 命中新 skill | 提示，不默认加入 |
| 远端删除 | 提示，默认保留 cache |
| forbidden | 提示重新登录或检查权限，默认保留 cache |

测试：

- fingerprint 变化触发 update。
- selector 命中新 skill 标记 `new_remote`。
- 404 标记 `missing_remote`。
- 403 标记 `forbidden`。
- `--frozen` 只报告不写文件。

验收：

- 手动同步覆盖更新、新增、删除、权限变化四类状态。

### 阶段 9：后台检查和提示

任务：

- `use` 完成渲染后执行轻量 metadata check。
- 默认不阻塞主流程。
- 支持 `background_check=false` 禁用。
- 结果写入 `.ticiou/.runtime/skillhub-pending.json`。
- 下次命令展示 pending 摘要。

提示：

```text
SkillHub updates available:
  updated: emrois/api-review 1.2.0 -> 1.3.0
  new: emrois/kafka-debug

Run `ticiou skill sync` to apply.
```

测试：

- 后台检查失败不导致 use 失败。
- pending 文件不包含 token。
- pending 能在下一次 status/use 中展示。

验收：

- 用户能看到变化，但不会被 `use` 自动改动 selection。

### 阶段 10：迁移和删除 legacy packaged skills

任务：

- 把当前 `profiles/shared/skills/azure-devops` 发布到 SkillHub。
- 为团队 baseline 配置 `global/baseline` 或 `emrois/team-shared` selector。
- 更新测试，不再断言 packaged skill 输出。
- 删除 `profiles/shared/skills/*`。
- 删除 `profiles/users/*/skills/*`。
- 移除 `legacy_packaged_skills` 默认路径。
- 如果不再使用 Claude local profile plugin，删除或标记 deprecated。

验收：

- `profiles/**/skills` 不再是 Ticiou 的默认 skill 来源。
- `use/setup` 仍可渲染非 skill 资源。
- SkillHub selection 是唯一 remote skill 来源。

## 9. 命令注册清单

新增：

```bash
ticiou skillhub login
ticiou skillhub whoami
ticiou skillhub logout
ticiou skill list --remote
ticiou skill add <namespace>/<slug>
ticiou skill remove <namespace>/<slug>
ticiou skill sync
```

修改：

```bash
ticiou use -u <user> --registry <url> --token <token>
ticiou use -u <user> --ask-token
ticiou use -u <user> --anonymous
ticiou use -u <user> --frozen
```

`--token` 只用于当前命令。文档和输出中应提醒它可能进入 shell history。

## 10. 测试矩阵

| 层级 | 覆盖点 |
| --- | --- |
| unit | registry、credentials、lock、config normalize、sync state |
| client | HTTP 状态码、Authorization header、JSON envelope、download |
| rendering | non-skill resources、skillhub managed files、manifest stale cleanup |
| command | login/whoami/logout、list/add/remove/sync、use flags |
| integration | 从空项目到 login/add/use/sync 的完整路径 |

CI 至少执行：

```bash
npm run typecheck
npm test
npm run build
```

## 11. 风险和处理

| 风险 | 处理 |
| --- | --- |
| config 解析继续手写导致 selection 难维护 | 阶段 1 先引入 YAML parser |
| 删除 packaged skills 破坏现有体验 | 先加 legacy 开关，SkillHub 路径稳定后删除 |
| token 泄漏到项目文件 | credentials 模块统一解析，lock/manifest schema 禁止 token 字段 |
| private skill 被 remove 误删 | 默认 disable only，cache 删除需要二次确认 |
| SkillHub discovery 未完成 | 第一版只支持显式 `skill add namespace/slug` 和 locked sync |
| Claude plugin 路径复杂 | 第一版远端 skill 直接写 `.claude/skills`，legacy plugin 后续删除 |

## 12. 第一版最小闭环

最小可交付版本只做这些：

1. 配置解析重构。
2. packaged skills 默认退出渲染。
3. SkillHub credentials/client/resolve/download。
4. `skillhub login/whoami/logout`。
5. `skill add <namespace>/<slug>`。
6. `use` 安装 locked skills。
7. `skill sync` 更新已选 skills。

这版不依赖 SkillHub 新 discovery API。它已经能完成“用户明确选择 skill，然后 Ticiou 稳定装配”的核心工作流。
