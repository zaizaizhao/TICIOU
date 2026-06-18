# Ticiou SkillHub Review 修复任务记录

状态：完成

> 维护规则：每完成或推迟一个修复，都更新对应任务状态、补充验证记录，并在“变更日志”写一条日期记录。不要只改代码不改本文件。

## 背景

2026-06-17 根据 ClaudeCode review 对 Ticiou SkillHub 集成做核对。结论：架构方向基本成立，但多用户 lock、selector 同步、失权渲染、离线/错误回退、二进制资源和提示语气存在需要修复的问题。

## 修复目标

- 多用户 profile 切换不能被 SkillHub lock 阻断。
- README 宣传的 selector selection 必须能同步，或文档必须移除该能力。
- 失权、缺失、离线等状态不能继续伪装成成功路径。
- 已缓存 skills 在合理条件下能离线渲染。
- Skill 包资源不能被 UTF-8 文本路径破坏。
- CLI 输出由结构化 tone 控制，不靠字符串猜测。
- manifest/cache 写入尽量避免半写、旧文件误删和 hash 不一致。

## 当前基线

- 2026-06-15：安装 Ticiou 依赖后执行 `pnpm run typecheck`，通过。
- 2026-06-15：执行 `pnpm run build && pnpm test`，36 个测试通过。
- 2026-06-15：新增 SkillHub 集成后执行 `pnpm run typecheck`、`pnpm test`、`pnpm run build`，47 个测试通过。
- 2026-06-15：SkillHub 后端在 Java 25 下使用 `-Dnet.bytebuddy.experimental=true` 执行 `./mvnw -pl skillhub-app -am test`，536 个测试通过。
- 2026-06-15：SkillHub web 执行 `make generate-api`、`make typecheck-web`、`make test-frontend`，602 个前端测试通过。
- 2026-06-17：完成本轮 review 修复；全量 `pnpm test`、`pnpm run typecheck`、`pnpm run build` 通过。

## 总体任务清单

- [x] P0：修复多用户 SkillHub lock 阻断切换。
- [x] P1：实现 selector selection 的 discover 展开与同步。
- [x] P1：失权或远端缺失的 skill 不再渲染。
- [x] P1：`use` 的 whoami 校验和同步网络失败支持降级到 lock/cache。
- [x] P1：Skill 包文件改为二进制安全写入。
- [x] P1：CLI message 改为结构化 tone。
- [x] P1：manifest 写入增加失败保护或原子化策略。
- [x] P2：cache 提取改为原子目录替换，并校验 fingerprint。
- [x] P2：清理 dead code，明确 `skill sync` auto-refresh 语义。
- [x] P2：补齐 README 和手工测试文档。

---

## 任务 1：P0 多用户 SkillHub lock

状态：完成

### 问题

当前 lock 固定为 `.ticiou/.runtime/skillhub-lock.json`。`readSkillHubLock()` 在 lock 内 profile/registry 与当前 profile/registry 不一致时直接抛错，导致用户 A 激活后，用户 B 如果也有 SkillHub selection，会切换失败。`clear all` 也不会清 lock。

### 涉及文件

- `src/project/paths.ts`
- `src/skillhub/lock.ts`
- `src/app/commands/profile/clear.ts`
- `src/app/commands/profile/use.ts`
- `src/app/commands/skill/sync.ts`
- `test/skillhub.test.ts`
- `test/commands.integration.test.ts`
- `README.md`

### 实施步骤

- [x] 写失败测试：两个用户都有 SkillHub selections 时，连续 `useProfile(A)`、`useProfile(B)` 不应报 lock belongs to profile。已失败，当前实现抛 `SkillHub lock belongs to profile...`；修复后通过。
- [x] 写失败测试：`clearResources({ scope: "all" })` 会删除所有 profile lock。已失败，当前实现保留 `.ticiou/.runtime/skillhub-lock.json`。
- [x] 将 lock 路径改为 profile/registry 隔离。实际路径：`.ticiou/.runtime/skillhub-locks/<slugified-profile>/<registry-hash>.json`。
- [x] 保留旧 `.ticiou/.runtime/skillhub-lock.json` 的兼容读取或迁移策略，避免已有项目立即坏掉。当前策略：匹配当前 profile/registry 时读取 legacy；不匹配时忽略并返回当前 profile 空 lock。
- [x] 更新 clear：`clear all` 清 lock 目录；`clear user` 只清当前 profile 的 rendered resources，不误删其它用户 lock。
- [x] 更新 README 中 lock 路径说明。
- [x] 运行验证命令：
  - `pnpm test -- test/skillhub.test.ts`
  - `pnpm test -- test/commands.integration.test.ts`
  - `pnpm run typecheck`

### 验收标准

- 用户 A 和用户 B 的 lock 互不覆盖、互不阻断。
- 旧单文件 lock 不会导致新版本直接崩溃。
- `clear all` 后不需要手动删 lock 就能重新 setup/use。

---

## 任务 2：P1 selector selection 同步

状态：完成

### 问题

`skill add --namespace emrois --owner self --label active` 会写入没有 `slug` 的 selector selection，但 `syncSelectedSkills()` 只遍历 explicit selections，selector 永远不 resolve/download/render。README 已宣传 selector 能“跟踪一组远端 skills”。

### 涉及文件

- `src/skillhub/selection.ts`
- `src/skillhub/sync.ts`
- `src/skillhub/client.ts`
- `src/app/commands/skill/add.ts`
- `src/app/commands/skill/remove.ts`
- `src/project/config.ts`
- `test/skillhub.test.ts`
- `test/commands.integration.test.ts`
- `README.md`

### 实施步骤

- [x] 写失败测试：selector selection 会调用 `client.discover({ namespace, owner, ownerId, label })`。已失败，当前实现没有调用 discover。
- [x] 写失败测试：discover 返回多个 skills 时，每个 skill 都会进入 lock 并渲染。已失败，当前实现 lock 为空。
- [x] 写失败测试：selector 后续 discover 少了一个 skill 时，按 `deletedSkillPolicy` 处理旧 lock entry。已失败，旧 entry 仍保持 installed。
- [x] 设计 selector 展开函数，例如 `expandSkillSelections(client, selections)`，返回 explicit skills，并保留 selector 来源。
- [x] `prompt-new` 暂时在非交互 sync 中按安全策略处理：只同步 discover 到的已选 selector 范围，新增远端 skill 需要明确规则。如果没有交互实现，先按 `newSkillPolicy` 执行。当前实现：selector 每次 discover 当前匹配集并同步；新增匹配项会安装，消失项标记 `missing_remote`。
- [x] 明确 `skill remove <namespace>/<slug>` 是否只移除 explicit selection；selector 产生的 skill 应通过删除 selector 或新增 disable entry 处理。当前实现保持原语义：`skill remove <namespace>/<slug>` 只移除 explicit selection；selector 产生项由 selector 管理。
- [x] 更新 README：说明 selector 的新增/删除/权限变化行为。
- [x] 运行验证命令：
  - `pnpm test -- test/skillhub.test.ts`
  - `pnpm test -- test/commands.integration.test.ts`
  - `pnpm run typecheck`

### 验收标准

- README 示例 selector 能实际下载和渲染 skills。
- selector 产生的 lock entry 能追踪来源 selector。
- 新增/删除远端 skill 的行为可解释、可测试。

---

## 任务 3：P1 失权和远端缺失不再渲染

状态：完成

### 问题

`installWithStatus()` 遇到 401/403/404 会把旧 lock entry 改为 `forbidden` 或 `missing_remote`，但 `collectSkillHubManagedFiles()` 只跳过 `disabled`，所以失权内容仍会从旧 cache 渲染并继续生效。

### 涉及文件

- `src/skillhub/sync.ts`
- `src/skillhub/install.ts`
- `src/skillhub/types.ts`
- `src/app/commands/profile/use.ts`
- `test/skillhub.test.ts`
- `test/commands.integration.test.ts`

### 实施步骤

- [x] 写失败测试：lock entry 状态为 `forbidden` 时不返回 managed files。已失败，当前实现仍从 cache 返回 managed files。
- [x] 写失败测试：已渲染 skill 后远端返回 403，再次 `useProfile()` 会移除 rendered file。通过。
- [x] 写失败测试：404 进入 `missing_remote` 后不渲染旧 cache。通过。
- [x] 将 `collectSkillHubManagedFiles()` 改为只渲染 `installed`、必要时渲染 `update_available` 或 `stale_cache`，明确跳过 `disabled`、`forbidden`、`missing_remote`。
- [x] `syncSelectedSkills()` 在 status 改变时输出 warning tone 消息。当前已输出明确文本；结构化 tone 留到任务 6。
- [x] 根据 `deletedSkillPolicy` 决定是否清 cache；第一阶段至少做到不再 render。当前实现保留 cache，但不再 render，符合 `keep-cache`。
- [x] 运行验证命令：
  - `pnpm test -- test/skillhub.test.ts`
  - `pnpm test -- test/commands.integration.test.ts`
  - `pnpm run typecheck`

### 验收标准

- 失权/缺失 skill 不会继续出现在 `.claude/skills` 或 `.github/skills`。
- manifest 会把旧 rendered skill 作为 stale file 删除。
- 用户能看到明确 warning，而不是绿色成功。

---

## 任务 4：P1 whoami 和离线 cache 回退

状态：完成

### 问题

`useProfile()` 中 whoami 只是提示 token 用户是否匹配 profile，却没有 try/catch。token 失效或 registry 不可达时，整个 `use` 失败。`syncSelectedSkills()` 在网络不可达时也无法使用已有 lock/cache 渲染。

### 涉及文件

- `src/app/commands/profile/use.ts`
- `src/app/commands/skill/sync.ts`
- `src/skillhub/sync.ts`
- `src/skillhub/client.ts`
- `src/skillhub/types.ts`
- `test/skillhub.test.ts`
- `test/commands.integration.test.ts`

### 实施步骤

- [x] 写失败测试：whoami 返回 401 时，`useProfile()` 不失败，输出 warning，并继续尝试 sync/render。已失败，当前实现直接抛 `SkillHub authentication failed.`。
- [x] 写失败测试：registry unreachable 且已有 installed lock/cache 时，`useProfile()` 能渲染 cache 并输出 warning。已失败，当前实现 resolve 网络失败后抛 `SkillHub registry unreachable.`。
- [x] 写失败测试：registry unreachable 但无 lock/cache 时，命令应失败或给出明确 error，不能静默成功。通过。
- [x] 在 `useProfile()` 中包住 whoami，只把 mismatch 或失败写入 warning message。
- [x] 在 `syncSelectedSkills()` 中识别无 HTTP status 的 `SkillHubError`，对已有 lock/cache 返回 `stale_cache` 或保持 `installed` 并附 warning。当前实现保持 existing lock entry，并输出 cached warning。
- [x] `--frozen` 离线时只检查 lock/cache，不写 lock/cache/render；若 cache 缺失则 warning/error 明确。
- [x] `SkillHubError` 保留 cause 或 detail，便于排查 DNS/TLS/ECONNREFUSED。
- [x] 运行验证命令：
  - `pnpm test -- test/skillhub.test.ts`
  - `pnpm test -- test/commands.integration.test.ts`
  - `pnpm run typecheck`

### 验收标准

- `use` 不因信息性 whoami 检查而硬失败。
- 已缓存 skills 在离线场景下仍可恢复渲染。
- 无缓存时失败清楚，不产生半成功状态。

---

## 任务 5：P1 Skill 包二进制安全

状态：完成

### 问题

`ManagedFile.content` 当前是 string，manifest 写入会 `normalizeContent()`，SkillHub 包里的所有文件也用 `readFile(..., "utf8")`。如果 skill 包包含图片、二进制资产或非 UTF-8 文件，会被破坏。

### 涉及文件

- `src/infra/manifest.ts`
- `src/infra/fs.ts`
- `src/skillhub/install.ts`
- `src/rendering/resources.ts`
- `test/manifest.test.ts`
- `test/skillhub.test.ts`
- `test/commands.integration.test.ts`

### 实施步骤

- [x] 写失败测试：SkillHub zip 包含 `assets/logo.png`，渲染后 bytes 与原始 bytes 完全一致。已失败，当前实现把 PNG bytes 当 UTF-8 字符串读出。
- [x] 写失败测试：manifest 对 binary file hash 基于原始 bytes，不做 CRLF normalize。
- [x] 将 `ManagedFile.content` 改为 `string | Uint8Array` 或 `Buffer`。
- [x] 增加 `hashManagedContent()`：文本保持当前 CRLF normalize；二进制直接 hash bytes。
- [x] 增加 `writeManagedFile()`：文本用 utf8，二进制直接 `writeFile(path, content)`。
- [x] `collectSkillHubManagedFiles()` 中除 `SKILL.md` 外按 bytes 读取；`SKILL.md` 仍按 utf8 处理 frontmatter。
- [x] `collectManagedResourceFiles()` 中 shared packaged skills 也同样处理 binary assets。
- [x] `assertFilesCanBeWritten()` 和 `removeStaleFiles()` 按 manifest hash 类型正确读取现有文件。
- [x] 运行验证命令：
  - `pnpm test -- test/manifest.test.ts`
  - `pnpm test -- test/skillhub.test.ts`
  - `pnpm run typecheck`

### 验收标准

- binary assets 渲染后 byte-for-byte 一致。
- 文本文件现有 CRLF 行为不回退。
- manifest 能正确保护 binary managed files 不被误删/误覆盖。

---

## 任务 6：P1 结构化 CLI message tone

状态：完成

### 问题

`formatCommandResult()` 通过 `classifyMessage()` 的字符串子串匹配决定 success/warning/error。权限失败、token mismatch、update available 等真实 warning 会被渲染成成功。

### 涉及文件

- `src/app/commands/types.ts`
- `src/cli/output.ts`
- `src/app/commands/**/*.ts`
- `test/cli-output.test.ts`
- `test/commands.integration.test.ts`

### 实施步骤

- [x] 写失败测试：`SkillHub token user X differs...` 渲染为 warning。已失败，当前 formatter 对对象调用 `toLowerCase`。
- [x] 写失败测试：`forbidden`、`missing_remote`、`update available` 渲染为 warning/error，而不是 success。
- [x] 定义类型：`type CommandMessage = string | { text: string; tone?: "success" | "warning" | "error" }`。
- [x] 将 `CommandResult.messages`、`DoctorResult.messages` 迁移到 `CommandMessage[]`，或新增兼容 normalize 函数。
- [x] `formatCommandResult()` 优先使用 message.tone；旧 string 仅兼容旧调用，逐步减少 `classifyMessage()` 使用。
- [x] 让产生消息的地方直接指定 tone。
- [x] 删除或缩小 `classifyMessage()`，避免新功能继续依赖字符串猜测。当前保留旧 string 兼容分类，新 warning/error 路径使用结构化 tone。
- [x] 运行验证命令：
  - `pnpm test -- test/cli-output.test.ts`
  - `pnpm test -- test/commands.integration.test.ts`
  - `pnpm run typecheck`

### 验收标准

- warning/error 不再因措辞变化变成成功。
- 旧测试中简单 success 文本仍能正常输出。
- CLI 输出无 token 泄漏。

---

## 任务 7：P1 manifest 写入失败保护

状态：完成

### 问题

`writeManagedFiles()` 先删除 stale files，再逐个写新文件，最后写 manifest。中途失败会造成旧文件已删、新文件半写、manifest 仍指向旧状态。

### 涉及文件

- `src/infra/manifest.ts`
- `src/infra/fs.ts`
- `test/manifest.test.ts`

### 实施步骤

- [x] 写失败测试：模拟第二个文件写入失败，旧 manifest 不应指向已经不存在的文件。已失败，当前实现先删 stale file，再写新文件。
- [x] 写失败测试：失败后不会留下 manifest 未记录的半写 managed file，或 manifest 会准确记录实际状态。已失败，当前实现保留了已写入但未进入 manifest 的新文件。
- [x] 选择最小策略：先写所有 next files，成功后再删除 stale files，最后写 manifest。实际实现增加 stale 删除预检与写入失败回滚。
- [x] 对“同一路径覆盖”场景保留当前 modified-file 保护。
- [x] 如需更强原子性，改为写临时文件后 rename；目录级替换暂不扩大范围。当前 manifest JSON 写入已用临时文件再 rename。
- [x] 运行验证命令：
  - `pnpm test -- test/manifest.test.ts`
  - `pnpm run typecheck`

### 验收标准

- 写入失败不会先删除旧的可用文件。
- manifest 与磁盘状态不会严重背离。
- 现有 unmanaged/modified file 保护不回退。

---

## 任务 8：P2 cache 提取原子性和 fingerprint

状态：完成

### 问题

`ensureCachedSkill()` 只要 cacheRoot 下有 `SKILL.md` 就跳过下载。同版本号被重新发布但 fingerprint 变化时，cache 内容可能与 lock fingerprint 不一致。提取过程先 rm 再 unzip，中途失败也会留下半个 cache。

### 涉及文件

- `src/skillhub/install.ts`
- `src/skillhub/sync.ts`
- `test/skillhub.test.ts`

### 实施步骤

- [x] 写失败测试：同 version 但 fingerprint 变化时会重新下载。已失败，当前实现只检查 `SKILL.md` 存在。
- [x] 写失败测试：extract 失败不会留下可被 `hasCachedSkill()` 误判的 cache。已失败，当前实现 fresh 解压失败后仍可能留下 `SKILL.md`。
- [x] 写失败测试：同 version 替换包解压失败时保留旧 cache。已失败，当前实现因未校验 fingerprint 而直接跳过替换。
- [x] 在 cacheRoot 写 `.ticiou-skillhub-cache.json`，记录 namespace、slug、version、fingerprint。
- [x] `hasCachedSkill()` 同时检查 `SKILL.md` 和 metadata fingerprint。
- [x] extract 到 sibling temp dir，成功后 rename 到 cacheRoot。当前实现替换前先把旧 cache rename 为 backup，失败时恢复。
- [x] 运行验证命令：
  - `pnpm test -- test/skillhub.test.ts`
  - `pnpm run typecheck`

### 验收标准

- cache 与 lock fingerprint 一致。
- 半提取 cache 不会被当成可用。

---

## 任务 9：P2 小风险清理和文档对齐

状态：完成

### 问题

存在若干低优先级但容易误导维护者的问题：`resources.ts` 中 profile skills 的 Claude 跳过逻辑已成 dead code；`skill sync` 硬编码 `autoRefresh: true` 未在 README 解释；setup anonymous 语义不清；YAML 手写缩进未来可能踩坑。

### 涉及文件

- `src/rendering/resources.ts`
- `src/app/commands/skill/sync.ts`
- `src/app/commands/project/setup.ts`
- `src/project/config.ts`
- `README.md`
- `docs/ticiou-skillhub-manual-test.md`
- `test/skillhub.test.ts`
- `test/commands.integration.test.ts`

### 实施步骤

- [x] 删除或注释说明 `resources.ts` 中 unreachable branch。已删除 profile skill 的 Claude 跳过分支；上层现在直接不收集 user profile skills。
- [x] 明确 `skill sync` 是否“强制刷新”。README 已写明普通 `skill sync` 会强制检查远端并刷新 lock/cache；`use` 才遵守 profile `auto_refresh`。
- [x] 明确 setup 是否必须 token。README 已写明 setup 默认需要 token；匿名模式适用于 `skill list --remote --anonymous`、已有 selection 的 `use --anonymous` 或 `skill sync --anonymous`。
- [x] 评估 `serializeProfileUsers()` 是否需要整体 YAML AST 序列化；若不改，在 README/测试里保持值简单。当前写入字段仍为简单标量和 selection 列表，暂不扩大为配置序列化重写。
- [x] 更新手工测试文档：多用户切换、selector、forbidden 下架、离线 cache、binary asset。
- [x] 运行验证命令：
  - `pnpm test`
  - `pnpm run typecheck`
  - `pnpm run build`

### 验收标准

- README 不宣传尚未实现的行为。
- 手工测试能覆盖本轮高风险修复。
- 低优先级清理不改变主流程行为。

---

## 变更日志

- 2026-06-17：创建 review 修复任务记录，拆分 P0/P1/P2 工作项。尚未修改实现代码。
- 2026-06-17：开始任务 1（P0 多用户 SkillHub lock），先补失败测试。
- 2026-06-17：完成任务 1 的代码修复：lock 改为 profile/registry 分文件，legacy lock 兼容读取，`clear all` 清理新旧 lock。
- 2026-06-17：开始任务 2（selector selection 同步），先补 discover 展开的失败测试。
- 2026-06-17：完成任务 2：selector 通过 discover 展开为 explicit skills，同步 lock/cache；selector 不再返回的旧 entry 标记为 `missing_remote`；README 补充 selector 行为。
- 2026-06-17：开始任务 3（失权和远端缺失不再渲染），先补 collect/render 层失败测试。
- 2026-06-17：完成任务 3：`forbidden` / `missing_remote` / `disabled` / `new_remote` 不再从 cache 渲染；远端 403/404 会更新 lock 状态并输出提示，manifest 会移除旧 rendered file。
- 2026-06-17：开始任务 4（whoami 和离线 cache 回退），先补 whoami 软失败测试。
- 2026-06-17：完成任务 4：whoami 软失败不阻断 use；registry unreachable 在已有 lock/cache 时使用 cache；无 cache 时继续失败；frozen 离线使用 cache；`SkillHubError` 保留 cause。
- 2026-06-17：开始任务 5（Skill 包二进制安全），先补 binary asset 失败测试。
- 2026-06-17：完成任务 5：ManagedFile 支持 string/Uint8Array，manifest 对 bytes 直接 hash/write，SkillHub 和 shared skills 的非 `SKILL.md` 文件按 bytes 渲染。
- 2026-06-17：开始任务 6（结构化 CLI message tone），先补 output 层失败测试。
- 2026-06-17：完成任务 6：新增 `CommandMessage` 结构化消息，formatter 优先使用 tone；SkillHub warning 路径改为 `{ text, tone: "warning" }`，旧 string 消息保持兼容。
- 2026-06-17：开始任务 7（manifest 写入失败保护），先补写入失败保留旧文件的失败测试。
- 2026-06-17：完成任务 7：`writeManagedFiles()` 增加 stale 删除预检、写入失败回滚和 manifest 临时文件 rename，避免旧文件先删和半写新文件遗留。
- 2026-06-17：开始任务 8（cache 提取原子性和 fingerprint），先补 fingerprint 变化重下与解压失败不误判 cache 的失败测试。
- 2026-06-17：完成任务 8：cache 写入 `.ticiou-skillhub-cache.json` fingerprint metadata，`hasCachedSkill()` 校验 metadata，包提取改为 temp/backup/rename，失败不会破坏旧 cache 或留下半 cache。
- 2026-06-17：完成任务 9：删除 resources dead code，README 明确 `skill sync` 强制刷新和 setup token 语义，手工测试文档补 selector、失权、离线、多用户和 binary 场景。

## 验证记录

- 2026-06-17：未运行测试，仅生成任务文档。
- 2026-06-17：`pnpm test -- test/skillhub.test.ts -t "keeps SkillHub locks isolated by profile"` 失败，原因是旧单文件 lock profile mismatch 直接抛错。
- 2026-06-17：`pnpm test -- test/commands.integration.test.ts -t "clears SkillHub locks when clearing all rendered resources"` 失败，原因是 `clear all` 后旧 lock 文件仍存在。
- 2026-06-17：`pnpm test -- test/skillhub.test.ts -t "keeps SkillHub locks isolated by profile"` 通过。
- 2026-06-17：`pnpm test -- test/commands.integration.test.ts -t "clears SkillHub locks when clearing all rendered resources"` 通过。
- 2026-06-17：`pnpm test -- test/commands.integration.test.ts -t "switches users when both profiles have SkillHub selections"` 通过。
- 2026-06-17：`pnpm test -- test/skillhub.test.ts` 通过，52 个测试通过。
- 2026-06-17：`pnpm test -- test/commands.integration.test.ts` 通过，52 个测试通过。
- 2026-06-17：`pnpm run typecheck` 通过。
- 2026-06-17：`pnpm test -- test/skillhub.test.ts -t "expands selector selections through discover"` 失败，原因是 selector selection 被过滤后没有调用 discover。
- 2026-06-17：`pnpm test -- test/skillhub.test.ts -t "marks selector-managed lock entries missing"` 失败，原因是 selector 不再返回的旧 lock entry 仍保持 installed。
- 2026-06-17：`pnpm test -- test/skillhub.test.ts -t "expands selector selections through discover"` 通过。
- 2026-06-17：`pnpm test -- test/skillhub.test.ts -t "marks selector-managed lock entries missing"` 通过。
- 2026-06-17：`pnpm test -- test/commands.integration.test.ts -t "adds selector selections"` 通过。
- 2026-06-17：任务 2 验证：`pnpm test -- test/skillhub.test.ts` 通过，55 个测试通过。
- 2026-06-17：任务 2 验证：`pnpm test -- test/commands.integration.test.ts` 通过，55 个测试通过。
- 2026-06-17：任务 2 验证：`pnpm run typecheck` 通过。
- 2026-06-17：`pnpm test -- test/skillhub.test.ts -t "does not render forbidden or missing"` 失败，原因是 `collectSkillHubManagedFiles` 只跳过 disabled。
- 2026-06-17：`pnpm test -- test/skillhub.test.ts -t "reports selected skills"` 失败，原因是 sync 将 entry 标为 forbidden/missing 但没有输出消息。
- 2026-06-17：`pnpm test -- test/skillhub.test.ts -t "does not render forbidden or missing"` 通过。
- 2026-06-17：`pnpm test -- test/commands.integration.test.ts -t "becomes forbidden"` 通过。
- 2026-06-17：`pnpm test -- test/commands.integration.test.ts -t "missing from the registry"` 通过。
- 2026-06-17：`pnpm test -- test/skillhub.test.ts -t "reports selected skills"` 通过。
- 2026-06-17：任务 3 验证：`pnpm test -- test/skillhub.test.ts` 通过，59 个测试通过。
- 2026-06-17：任务 3 验证：`pnpm test -- test/commands.integration.test.ts` 通过，59 个测试通过。
- 2026-06-17：任务 3 验证：`pnpm run typecheck` 通过。
- 2026-06-17：`pnpm test -- test/commands.integration.test.ts -t "whoami soft validation"` 失败，原因是 whoami 401 直接让 `useProfile` 抛错。
- 2026-06-17：`pnpm test -- test/commands.integration.test.ts -t "locked cache"` 失败，原因是 sync 遇到 registry unreachable 不使用已有 lock/cache。
- 2026-06-17：`pnpm test -- test/skillhub.test.ts -t "frozen sync uses locked cache"` 失败，原因是 frozen resolve unreachable 直接 rethrow。
- 2026-06-17：`pnpm test -- test/skillhub.test.ts -t "preserves the original cause"` 失败，原因是 `SkillHubError` 未设置 `cause`。
- 2026-06-17：`pnpm test -- test/commands.integration.test.ts -t "whoami soft validation"` 通过。
- 2026-06-17：`pnpm test -- test/commands.integration.test.ts -t "locked cache"` 通过。
- 2026-06-17：`pnpm test -- test/commands.integration.test.ts -t "without a locked cache"` 通过。
- 2026-06-17：`pnpm test -- test/skillhub.test.ts -t "frozen sync uses locked cache"` 通过。
- 2026-06-17：`pnpm test -- test/skillhub.test.ts -t "preserves the original cause"` 通过。
- 2026-06-17：任务 4 验证：`pnpm test -- test/skillhub.test.ts` 通过，64 个测试通过。
- 2026-06-17：任务 4 验证：`pnpm test -- test/commands.integration.test.ts` 通过，64 个测试通过。
- 2026-06-17：任务 4 验证：`pnpm run typecheck` 通过。
- 2026-06-17：`pnpm test -- test/skillhub.test.ts -t "preserves binary assets"` 失败，原因是 SkillHub package 非 `SKILL.md` 文件按 UTF-8 读取。
- 2026-06-17：`pnpm test -- test/skillhub.test.ts -t "preserves binary assets"` 通过。
- 2026-06-17：`pnpm test -- test/manifest.test.ts -t "binary files"` 通过。
- 2026-06-17：`pnpm test -- test/commands.integration.test.ts -t "binary assets"` 通过。
- 2026-06-17：任务 5 验证：`pnpm test -- test/manifest.test.ts` 通过，67 个测试通过。
- 2026-06-17：任务 5 验证：`pnpm test -- test/skillhub.test.ts` 通过，67 个测试通过。
- 2026-06-17：任务 5 验证：`pnpm test -- test/commands.integration.test.ts` 通过，67 个测试通过。
- 2026-06-17：任务 5 验证：`pnpm run typecheck` 通过。
- 2026-06-17：`pnpm test -- test/cli-output.test.ts -t "structured message tones"` 失败，原因是 `formatMessage` 仍假定 message 是 string。
- 2026-06-17：`pnpm test -- test/cli-output.test.ts -t "structured message tones"` 通过。
- 2026-06-17：任务 6 验证：`pnpm test -- test/cli-output.test.ts` 通过，68 个测试通过。
- 2026-06-17：任务 6 验证：`pnpm test -- test/skillhub.test.ts` 通过，68 个测试通过。
- 2026-06-17：任务 6 验证：`pnpm test -- test/commands.integration.test.ts` 通过，68 个测试通过。
- 2026-06-17：任务 6 验证：`pnpm run typecheck` 通过。
- 2026-06-17：`pnpm test -- test/manifest.test.ts -t "keeps previous rendered files"` 失败，原因是 `writeManagedFiles()` 在新文件写入失败前已经删除旧 rendered file。
- 2026-06-17：`pnpm test -- test/manifest.test.ts -t "removes newly written files"` 失败，原因是多个 next files 中后续写入失败时，前面已写入的新文件未回滚。
- 2026-06-17：`pnpm test -- test/manifest.test.ts -t "keeps previous rendered files|removes newly written files"` 通过，任务 7 写入失败回滚测试转绿。
- 2026-06-17：任务 7 验证：`pnpm test -- test/manifest.test.ts` 通过，70 个测试通过。
- 2026-06-17：任务 7 验证：`pnpm run typecheck` 通过。
- 2026-06-17：`pnpm test -- test/skillhub.test.ts -t "redownloads cached skills|preserves the existing cache|failed fresh extraction"` 失败，原因是 cache 仅按 `SKILL.md` 判断，缺少 fingerprint metadata 且解压失败会留下半 cache。
- 2026-06-17：`pnpm test -- test/skillhub.test.ts -t "redownloads cached skills|preserves the existing cache|failed fresh extraction"` 通过，任务 8 cache metadata 和临时目录替换测试转绿。
- 2026-06-17：任务 8 验证：`pnpm test -- test/skillhub.test.ts` 通过，73 个测试通过。
- 2026-06-17：任务 8 验证：`pnpm run typecheck` 通过。
- 2026-06-17：任务 9 / 全量验证：`pnpm test` 通过，73 个测试通过。
- 2026-06-17：任务 9 / 全量验证：`pnpm run typecheck` 通过。
- 2026-06-17：任务 9 / 全量验证：`pnpm run build` 通过。
