# Ticiou SkillHub 手工测试文档

本文档用于验证 Ticiou 的 SkillHub-first 初始化、远端 skill 选择、同步、重渲染和清理流程。

## 0. 测试约定

### 0.1 推荐执行顺序

建议按下面顺序跑，先走一条完整闭环，再补测扩展场景：

1. 第 0.4 节：启动 SkillHub，并准备一个已经发布的测试 skill。
2. 第 1 节：检查 SkillHub、token、Ticiou CLI。
3. 第 2 节：执行 `ticiou setup -p claude`，验证 SkillHub skill 被下载、锁定、渲染。
4. 第 3 节：执行 `status` 和 `doctor`。
5. 第 4 到 12 节：补测凭据、列表筛选、add/sync/remove、selector、离线回退、多平台和清理。

Ticiou 的 `setup` 默认通过 `owner=self` 发现当前 token 用户拥有的 SkillHub skills，并且后续同步需要能 `resolve` 和 `download` 已发布版本。因此主流程必须至少准备一个 `PUBLISHED` skill。普通用户发布通常会进入审核态，不适合作为主流程的唯一测试数据。

### 0.2 变量

把下面变量替换成你的真实值：

```bash
export SKILLHUB_REGISTRY="http://localhost:8080"
export SKILLHUB_TOKEN="sk_xxx"
export TICIOU_BIN="ticiou"
export TICIOU_TEST_NAMESPACE="global"
export TICIOU_TEST_SKILL="ticiou-e2e-skill"
export TICIOU_TEST_REF="$TICIOU_TEST_NAMESPACE/$TICIOU_TEST_SKILL"
```

`TICIOU_BIN` 必须是一个可直接执行的命令或文件路径。推荐二选一：

```bash
# 方式 A：使用 npm link 后的全局命令
cd /Volumes/zaizaizhao/demo/TICIOU
pnpm run build
npm link
export TICIOU_BIN="ticiou"
```

```bash
# 方式 B：直接使用仓库里的可执行入口
cd /Volumes/zaizaizhao/demo/TICIOU
pnpm run build
export TICIOU_BIN="/Volumes/zaizaizhao/demo/TICIOU/bin/ticiou.js"
```

不要把 `TICIOU_BIN` 设置成带空格的字符串，例如 `node /path/to/dist/cli/index.js`，因为本文档中的命令使用 `"$TICIOU_BIN"` 形式执行。

本文档分两类 setup：

- 交互测试：不加 `--yes`，用于验证终端会展示 SkillHub skills 选择界面。
- 可复制的非交互测试：加 `--yes`，用于直接启用 discover 到的全部 skills。

如果要测试前端代理，把 `SKILLHUB_REGISTRY` 改成：

```bash
export SKILLHUB_REGISTRY="http://localhost:3000"
```

### 0.3 安全要求

- 不要把真实 token 写入文档、提交记录或聊天消息。
- 如果 token 已经泄露，先在 SkillHub 中吊销，再重新生成。
- 本文档所有 `sk_xxx` 都是占位符。
- `SKILLHUB_TOKEN` 只放在当前 shell 环境变量中；需要长期保存时，用第 4 节的 `ticiou skillhub login`。
- 测试结束后如果不再使用该 token，在 SkillHub token 页面吊销，或删除本机凭据。

### 0.4 SkillHub 本地环境和测试数据准备

本节用于准备 Ticiou 主流程需要消费的 SkillHub 数据。推荐本地使用 `local-admin`，因为它拥有 `SUPER_ADMIN`，通过 CLI publish 后版本会直接成为 `PUBLISHED`，可以立刻被 Ticiou discover、resolve 和 download。

如果你要验证普通用户审核流，可以后续另用 `local-user` 发布；但普通用户发布出来的版本通常是 `PENDING_REVIEW`，需要审核通过后才能作为 Ticiou 主流程数据。

#### 0.4.1 启动 SkillHub

命令：

```bash
cd /Volumes/zaizaizhao/demo/skillhub
make dev-all
```

预期结果：

- Web UI 可访问：`http://localhost:3000`
- Backend API 可访问：`http://localhost:8080`
- Scanner 可访问：`http://localhost:8000`
- 命令输出本地 mock 用户：

```text
local-user  -> X-Mock-User-Id: local-user
local-admin -> X-Mock-User-Id: local-admin
```

检查：

```bash
curl -sf http://localhost:8080/actuator/health
curl -sf http://localhost:3000
```

#### 0.4.2 生成本地测试 token

如果你已经有可用 token，可以跳过本节，直接 `export SKILLHUB_TOKEN="sk_xxx"`。

命令：

```bash
export SKILLHUB_REGISTRY="http://localhost:8080"
COOKIE_FILE="$(mktemp)"

curl -sS -c "$COOKIE_FILE" \
  -H "X-Mock-User-Id: local-admin" \
  "$SKILLHUB_REGISTRY/api/v1/auth/providers" >/dev/null

CSRF_TOKEN="$(awk '$6 == "XSRF-TOKEN" { print $7 }' "$COOKIE_FILE" | tail -n 1)"

TOKEN_RESPONSE="$(curl -sS -b "$COOKIE_FILE" -c "$COOKIE_FILE" \
  -H "X-Mock-User-Id: local-admin" \
  -H "X-XSRF-TOKEN: $CSRF_TOKEN" \
  -H "Content-Type: application/json" \
  -X POST "$SKILLHUB_REGISTRY/api/v1/tokens" \
  -d '{"name":"ticiou-manual-test","scopes":["skill:read","skill:publish"]}')"

export SKILLHUB_TOKEN="$(printf '%s' "$TOKEN_RESPONSE" | node -e 'let s = ""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => console.log(JSON.parse(s).data.token));')"
```

检查：

```bash
test -n "$SKILLHUB_TOKEN"
curl -sf -H "Authorization: Bearer $SKILLHUB_TOKEN" \
  "$SKILLHUB_REGISTRY/api/cli/v1/auth/whoami"
```

预期结果：

- `whoami` 响应中 `data.handle` 为 `local-admin`。
- 后续 Ticiou profile 名也应是 `local-admin`。

#### 0.4.3 创建测试 skill 包

命令：

```bash
export TICIOU_TEST_NAMESPACE="global"
export TICIOU_TEST_SKILL="ticiou-e2e-skill"
export TICIOU_TEST_REF="$TICIOU_TEST_NAMESPACE/$TICIOU_TEST_SKILL"
export TICIOU_TEST_VERSION="1.0.$(date +%s)"
export TICIOU_TEST_ROOT="/tmp/ticiou-skillhub-publish"

rm -rf "$TICIOU_TEST_ROOT"
mkdir -p "$TICIOU_TEST_ROOT/$TICIOU_TEST_SKILL/assets"

cat > "$TICIOU_TEST_ROOT/$TICIOU_TEST_SKILL/SKILL.md" <<EOF
---
name: $TICIOU_TEST_SKILL
description: SkillHub skill used by Ticiou manual E2E test.
version: $TICIOU_TEST_VERSION
---

# Ticiou E2E Skill

This skill verifies SkillHub to Ticiou sync.
EOF

printf 'asset-check\n' > "$TICIOU_TEST_ROOT/$TICIOU_TEST_SKILL/assets/check.txt"
printf '\x89PNG\r\n\x1a\nmanual-test\n' > "$TICIOU_TEST_ROOT/$TICIOU_TEST_SKILL/assets/logo.png"

cd "$TICIOU_TEST_ROOT/$TICIOU_TEST_SKILL"
zip -qr "$TICIOU_TEST_ROOT/$TICIOU_TEST_SKILL.zip" .
```

检查：

```bash
unzip -l "$TICIOU_TEST_ROOT/$TICIOU_TEST_SKILL.zip"
```

预期结果：

- zip 根目录包含 `SKILL.md`。
- `SKILL.md` frontmatter 中的 `name` 是 `ticiou-e2e-skill`。
- zip 中包含 `assets/check.txt` 和 `assets/logo.png`。

#### 0.4.4 发布测试 skill 到 SkillHub

命令：

```bash
PUBLISH_RESPONSE="$(curl -sS \
  -H "Authorization: Bearer $SKILLHUB_TOKEN" \
  -F "file=@$TICIOU_TEST_ROOT/$TICIOU_TEST_SKILL.zip" \
  -F "visibility=PUBLIC" \
  "$SKILLHUB_REGISTRY/api/cli/v1/skills/$TICIOU_TEST_NAMESPACE/publish")"

printf '%s\n' "$PUBLISH_RESPONSE"
```

预期结果：

- 响应 `code` 为 `0`。
- 响应 `data.namespace` 为 `global`。
- 响应 `data.slug` 为 `ticiou-e2e-skill`。
- 响应 `data.version` 为 `$TICIOU_TEST_VERSION`。

如果发布失败：

- `version exists`：重新执行第 0.4.3 节生成新的 `TICIOU_TEST_VERSION`，再发布。
- 权限失败：确认 token 是 `local-admin` 生成的，或确认目标 namespace 可写。
- 校验失败：确认 zip 根目录直接包含 `SKILL.md`，不是多包了一层目录。

#### 0.4.5 验证 SkillHub CLI API 可被 Ticiou 消费

命令：

```bash
curl -sf -H "Authorization: Bearer $SKILLHUB_TOKEN" \
  "$SKILLHUB_REGISTRY/api/cli/v1/skills/discover?owner=self&namespace=$TICIOU_TEST_NAMESPACE&q=$TICIOU_TEST_SKILL&size=20"

curl -sf -H "Authorization: Bearer $SKILLHUB_TOKEN" \
  "$SKILLHUB_REGISTRY/api/cli/v1/skills/$TICIOU_TEST_NAMESPACE/$TICIOU_TEST_SKILL/resolve"

curl -sf -H "Authorization: Bearer $SKILLHUB_TOKEN" \
  -o "$TICIOU_TEST_ROOT/downloaded-$TICIOU_TEST_SKILL.zip" \
  "$SKILLHUB_REGISTRY/api/cli/v1/skills/$TICIOU_TEST_NAMESPACE/$TICIOU_TEST_SKILL/versions/$TICIOU_TEST_VERSION/download"
```

预期结果：

- discover 结果包含 `$TICIOU_TEST_REF`。
- resolve 结果包含 `fingerprint` 和 `downloadUrl`。
- download 命令退出码为 0，并生成 `$TICIOU_TEST_ROOT/downloaded-$TICIOU_TEST_SKILL.zip`。

到这里，SkillHub 侧准备完成，可以继续执行第 1 节和第 2 节。

## 1. 前置环境检查

### 1.1 检查 SkillHub 后端

命令：

```bash
curl -sf "$SKILLHUB_REGISTRY/actuator/health"
```

预期结果：

- 使用 `http://localhost:8080` 时返回健康状态 JSON。
- 命令退出码为 0。

失败排查：

- 如果 8080 不通，先在 `skillhub/` 下运行 `make dev-all`。
- 如果使用 3000，健康检查可能不适用；改测第 1.3 节。

### 1.2 检查 SkillHub token

命令：

```bash
"$TICIOU_BIN" skillhub whoami \
  --registry "$SKILLHUB_REGISTRY" \
  --token "$SKILLHUB_TOKEN"
```

预期结果：

- 包含 `Registry: <registry>`。
- 包含 `Token source: flag`。
- 包含 `User: <user>`。
- 命令退出码为 0。

失败排查：

- `SkillHub authentication failed.`：token 无效、过期或不属于该 registry。
- `SkillHub request failed`：registry 地址或后端服务异常。

### 1.3 检查 3000 前端代理

仅在 `SKILLHUB_REGISTRY=http://localhost:3000` 时执行。

命令：

```bash
curl -sf http://localhost:3000
curl -sf http://localhost:3000/api/cli/v1/skills/discover?size=1
```

预期结果：

- 第一个命令返回前端 HTML。
- 第二个命令能通过 Vite proxy 请求到后端 API。

失败排查：

- 3000 失败但 8080 成功，说明前端 dev server 或 proxy 未启动。
- 改用 `--registry http://localhost:8080` 继续测试 Ticiou 主流程。

### 1.4 检查 Ticiou 本地命令

命令：

```bash
which "$TICIOU_BIN"
"$TICIOU_BIN" --version
"$TICIOU_BIN" --help
```

预期结果：

- `which` 指向你要测试的本地版本。
- `--help` 中包含 `setup            Initialize, install, and activate SkillHub skills`。
- `--help` 中不再把 `setup -u <user>` 作为默认初始化路径。

如果 `TICIOU_BIN` 使用的是绝对路径，例如 `/Volumes/zaizaizhao/demo/TICIOU/bin/ticiou.js`，`which "$TICIOU_BIN"` 可能没有输出；这种情况下改用：

```bash
test -x "$TICIOU_BIN"
"$TICIOU_BIN" --version
"$TICIOU_BIN" --help
```

失败排查：

```bash
cd /Volumes/zaizaizhao/demo/TICIOU
pnpm run build
npm link
```

然后重新执行本节命令。

## 2. 主流程：setup 初始化 Claude

### 2.1 创建干净测试目录

命令：

```bash
rm -rf /tmp/ticiou-manual-claude
mkdir -p /tmp/ticiou-manual-claude
cd /tmp/ticiou-manual-claude
```

预期结果：

- 当前目录为空。

检查：

```bash
pwd
find . -maxdepth 2 -type f | sort
```

### 2.2 执行非交互 setup 主流程

命令：

```bash
"$TICIOU_BIN" setup \
  -p claude \
  --registry "$SKILLHUB_REGISTRY" \
  --token "$SKILLHUB_TOKEN" \
  --yes
```

说明：

- 主流程使用 `--yes`，用于直接启用 SkillHub discover 到的全部当前用户 skills。
- 如果你按第 0.4 节准备数据，至少应启用 `$TICIOU_TEST_REF`。
- 交互选择界面另见第 2.3 节。

输出预期：

- 包含 `Initialized Ticiou project at ...`
- 包含 `Claude adapter installed`
- 包含 `Authenticated SkillHub user local-admin`，或你的 token 对应用户。
- 包含 `Selected <n> SkillHub skill(s)`。
- 包含 `Installed SkillHub skill global/ticiou-e2e-skill@<version>`，或你实际准备的测试 skill。
- 包含 `Activated Ticiou profile local-admin`，或你的 token 对应用户。

文件预期：

```bash
test -f .ticiou/config.yaml
test -f .ticiou/.runtime/current-profile
test -f .ticiou/.runtime/manifest.json
test -d .claude
test -f .claude/settings.json
test -d .claude/skills
test -f ".claude/skills/skillhub-$TICIOU_TEST_NAMESPACE-$TICIOU_TEST_SKILL/SKILL.md"
test -f ".claude/skills/skillhub-$TICIOU_TEST_NAMESPACE-$TICIOU_TEST_SKILL/assets/check.txt"
test -f ".claude/skills/skillhub-$TICIOU_TEST_NAMESPACE-$TICIOU_TEST_SKILL/assets/logo.png"
```

SkillHub lock/cache 预期：

```bash
find .claude/skills -maxdepth 3 -type f | sort
find .ticiou/.runtime/skillhub-cache -maxdepth 6 -type f | sort
find .ticiou/.runtime/skillhub-locks -type f | sort
```

配置预期：

```bash
cat .ticiou/config.yaml
cat .ticiou/.runtime/current-profile
```

`.ticiou/config.yaml` 应包含：

```yaml
profiles:
  default_user: local-admin
  users:
    local-admin:
      skillhub:
        registry: http://localhost:8080
        selections:
          - namespace: global
            slug: ticiou-e2e-skill
            policy: auto
```

如果你使用的不是第 0.4 节的 `local-admin/global/ticiou-e2e-skill`，把上面的 profile、namespace 和 slug 换成实际值。

### 2.3 可选：交互选择 setup

命令：

```bash
rm -rf /tmp/ticiou-manual-claude-interactive
mkdir -p /tmp/ticiou-manual-claude-interactive
cd /tmp/ticiou-manual-claude-interactive

"$TICIOU_BIN" setup \
  -p claude \
  --registry "$SKILLHUB_REGISTRY" \
  --token "$SKILLHUB_TOKEN"
```

交互预期：

- 如果 SkillHub 返回可选 skills，终端展示：

```text
Signed in as <user>

Select SkillHub skills to enable for this project:
  1. <namespace>/<slug>@<version> - <summary>

Enable which skills? [all]
```

- 直接回车：启用全部候选 skills。
- 输入 `none`：不启用任何 SkillHub skill。
- 输入 `1,3`：只启用第 1 和第 3 个。

输出预期：

- 包含 `Initialized Ticiou project at ...`
- 包含 `Claude adapter installed`
- 包含 `Authenticated SkillHub user <user>`
- 包含 `Selected <n> SkillHub skill(s)`
- 如果选中了 skill，包含 `Installed SkillHub skill <namespace>/<slug>@<version>`
- 包含 `Activated Ticiou profile <user>`

检查：

```bash
test -f .ticiou/config.yaml
test -f .ticiou/.runtime/current-profile
test -f .ticiou/.runtime/manifest.json
test -d .claude
test -f .claude/settings.json
test -d .claude/skills
```

如果选中了 skills，还应存在对应的 `.claude/skills/skillhub-<namespace>-<slug>/SKILL.md`、SkillHub cache 和 lock：

```bash
find .claude/skills -maxdepth 3 -type f | sort
find .ticiou/.runtime/skillhub-cache -maxdepth 6 -type f | sort
find .ticiou/.runtime/skillhub-locks -type f | sort
```

## 3. 状态与健康检查

### 3.1 status

命令：

```bash
"$TICIOU_BIN" status
```

预期结果：

- `profile` 为 SkillHub token 对应用户。
- `platforms` 包含 `claude`。
- `generated files` 大于 0。
- `Next:` 指向 `ticiou doctor`。

### 3.2 doctor

命令：

```bash
"$TICIOU_BIN" doctor
```

预期结果：

- 包含 `Claude adapter installed`
- 包含 `Claude hooks registered`
- 包含 `Active profile: <user>`
- 包含 `Manifest files verified`
- 结尾显示 `Done`

不应出现：

```text
Claude local profile plugin
ticiou-local-profiles
```

失败排查：

- `Missing generated file`：检查是否手动删除了 `.claude/` 或 `.ticiou/.runtime/manifest.json` 中记录的文件。
- `Refusing to overwrite unmanaged file`：目标目录已有非 Ticiou 管理文件，换干净目录测试。

## 4. SkillHub 凭据流程

### 4.1 保存 token

命令：

```bash
"$TICIOU_BIN" skillhub login \
  --registry "$SKILLHUB_REGISTRY" \
  --token "$SKILLHUB_TOKEN"
```

预期结果：

- 包含 `Logged in to SkillHub <registry> as <user>`
- 包含 `Saved SkillHub token for <registry>`
- 生成或更新 `~/.ticiou/skillhub-credentials.json`

检查：

```bash
test -f ~/.ticiou/skillhub-credentials.json
ls -l ~/.ticiou/skillhub-credentials.json
```

POSIX 权限预期：

```text
-rw-------
```

### 4.2 交互输入并保存 token

仅在真实终端中执行，不要带 `--token`。如果本机已经保存了该 registry 的 token，先执行第 4.4 节 logout 后再测本节。

命令：

```bash
rm -rf /tmp/ticiou-manual-prompt-token
mkdir -p /tmp/ticiou-manual-prompt-token
cd /tmp/ticiou-manual-prompt-token

"$TICIOU_BIN" setup \
  -p claude \
  --registry "$SKILLHUB_REGISTRY" \
  --yes
```

交互预期：

```text
SkillHub token not found for <registry>.
Paste SkillHub token:
Save token locally? [Y/n]
```

操作：

- 粘贴 token 后回车。
- 输入 `Y` 或直接回车。

预期结果：

- 命令继续执行，不会在 `Save token locally? [Y/n]` 后直接退出。
- setup 成功完成。
- `~/.ticiou/skillhub-credentials.json` 写入该 registry 的 token。

### 4.3 使用已保存 token 执行 setup

命令：

```bash
rm -rf /tmp/ticiou-manual-saved-token
mkdir -p /tmp/ticiou-manual-saved-token
cd /tmp/ticiou-manual-saved-token

"$TICIOU_BIN" setup \
  -p claude \
  --registry "$SKILLHUB_REGISTRY" \
  --yes
```

预期结果：

- 不再提示 `Paste SkillHub token`。
- 直接启用 discover 到的全部 SkillHub skills。
- setup 成功完成。

### 4.4 删除已保存 token

命令：

```bash
"$TICIOU_BIN" skillhub logout \
  --registry "$SKILLHUB_REGISTRY"
```

预期结果：

- 包含 `Removed saved SkillHub token for <registry>`。
- 再执行不带 `--token` 的 `skillhub whoami` 时，输出 `Token source: anonymous` 和 `No SkillHub user authenticated`。

## 5. 远端 skills 列表与筛选

### 5.1 列出当前可见 skills

命令：

```bash
"$TICIOU_BIN" skill list \
  --remote \
  --registry "$SKILLHUB_REGISTRY" \
  --token "$SKILLHUB_TOKEN"
```

预期结果：

- 包含 `Registry: <registry>`
- 包含 `Token source: flag`
- 有 skills 时输出 `<namespace>/<slug>@<version> <visibility> - <summary>`
- 无 skills 时输出 `No remote SkillHub skills found`

### 5.2 只列出当前用户 skills

命令：

```bash
"$TICIOU_BIN" skill list \
  --remote \
  --owner self \
  --registry "$SKILLHUB_REGISTRY" \
  --token "$SKILLHUB_TOKEN"
```

预期结果：

- 返回当前 token 用户可见且 owner 为 self 的 skills。
- 如果按第 0.4 节准备数据，应包含 `$TICIOU_TEST_REF`。

### 5.3 按 namespace 筛选

命令：

```bash
"$TICIOU_BIN" skill list \
  --remote \
  --namespace "$TICIOU_TEST_NAMESPACE" \
  --registry "$SKILLHUB_REGISTRY" \
  --token "$SKILLHUB_TOKEN"
```

预期结果：

- 返回 namespace 为 `$TICIOU_TEST_NAMESPACE` 的 skills。
- 如果没有匹配项，输出 `No remote SkillHub skills found`。

## 6. 添加、同步和移除 explicit skill

以下命令默认使用第 0.4 节准备的 `$TICIOU_TEST_REF`。如果你使用别的 skill，把 `$TICIOU_TEST_REF` 替换成第 5 节列表中的真实值。

### 6.1 添加 explicit skill

命令：

```bash
cd /tmp/ticiou-manual-claude

"$TICIOU_BIN" skill add "$TICIOU_TEST_REF" \
  --registry "$SKILLHUB_REGISTRY" \
  --token "$SKILLHUB_TOKEN"
```

预期结果：

- 包含 `Added SkillHub selection for profile <user>` 或 `SkillHub selection already exists for profile <user>`。
- 包含 `Installed SkillHub skill $TICIOU_TEST_REF@<version>` 或已是最新状态。
- `.ticiou/config.yaml` 的 selections 中包含该 skill。
- `.claude/skills/skillhub-$TICIOU_TEST_NAMESPACE-$TICIOU_TEST_SKILL/SKILL.md` 存在。

检查：

```bash
cat .ticiou/config.yaml
find .claude/skills -maxdepth 3 -type f | sort
```

### 6.2 同步 skills

命令：

```bash
"$TICIOU_BIN" skill sync \
  --registry "$SKILLHUB_REGISTRY" \
  --token "$SKILLHUB_TOKEN"
```

预期结果：

- 包含 `Checked SkillHub selections for profile <user>`
- 若无变化，包含 `SkillHub skills already up to date`
- 若远端有更新，包含 `SkillHub lock updated`
- 渲染目录与 lock 文件保持一致。
- 普通 `skill sync` 会主动检查远端并刷新 lock/cache；不要把它当作只按本地 `auto_refresh` 策略渲染的命令。

检查：

```bash
find .ticiou/.runtime/skillhub-locks -type f | sort
find .ticiou/.runtime/skillhub-cache -name .ticiou-skillhub-cache.json -print
```

### 6.3 frozen 同步

命令：

```bash
"$TICIOU_BIN" skill sync \
  --registry "$SKILLHUB_REGISTRY" \
  --token "$SKILLHUB_TOKEN" \
  --frozen
```

预期结果：

- 只检查远端状态。
- 不写入新的 rendered files。
- 不写入新的 lock/cache。
- 如果缺少 lock，会提示 frozen mode 跳过安装。

### 6.4 移除 explicit skill

命令：

```bash
"$TICIOU_BIN" skill remove "$TICIOU_TEST_REF" \
  --registry "$SKILLHUB_REGISTRY"
```

预期结果：

- 包含 `Removed SkillHub selection $TICIOU_TEST_REF from profile <user>`。
- 包含 `Local SkillHub cache was kept`。
- `.ticiou/config.yaml` 中不再包含该 explicit selection。

再执行：

```bash
"$TICIOU_BIN" use \
  -u "$(cat .ticiou/.runtime/current-profile)" \
  --registry "$SKILLHUB_REGISTRY" \
  --token "$SKILLHUB_TOKEN"
```

预期结果：

- 被移除的 skill 对应 `.claude/skills/skillhub-$TICIOU_TEST_NAMESPACE-$TICIOU_TEST_SKILL/` 不再作为当前 selection 渲染。

如果你后面还要继续跑第 7、8、10 节，并且需要至少一个 SkillHub selection，可以重新加回来：

```bash
"$TICIOU_BIN" skill add "$TICIOU_TEST_REF" \
  --registry "$SKILLHUB_REGISTRY" \
  --token "$SKILLHUB_TOKEN"
```

## 7. 重新渲染当前 profile

命令：

```bash
cd /tmp/ticiou-manual-claude

"$TICIOU_BIN" use \
  -u "$(cat .ticiou/.runtime/current-profile)" \
  --registry "$SKILLHUB_REGISTRY" \
  --token "$SKILLHUB_TOKEN"
```

预期结果：

- 包含 `Activated Ticiou profile <user>`。
- 已配置 SkillHub selections 时，会重新同步 lock/cache 并渲染。
- 不安装 Claude local profile plugin。
- 不生成 `.claude/settings.local.json`。
- 不生成 `.ticiou/.runtime/claude-plugin-marketplace/`。

检查：

```bash
test ! -f .claude/settings.local.json
test ! -d .ticiou/.runtime/claude-plugin-marketplace
"$TICIOU_BIN" doctor
```

## 8. Selector、权限和离线回退

### 8.1 selector selection

本节需要 SkillHub 中存在匹配 label 的 skill。第 0.4 节创建的测试 skill 默认没有 label；如果你还没有可用 label，可以先跳过本节，或在 SkillHub UI/API 给测试 skill 加一个 label 后再测。

命令：

```bash
cd /tmp/ticiou-manual-claude

"$TICIOU_BIN" skill add \
  --namespace "$TICIOU_TEST_NAMESPACE" \
  --owner self \
  --label active \
  --registry "$SKILLHUB_REGISTRY" \
  --token "$SKILLHUB_TOKEN"

"$TICIOU_BIN" skill sync \
  --registry "$SKILLHUB_REGISTRY" \
  --token "$SKILLHUB_TOKEN"
```

预期结果：

- `.ticiou/config.yaml` 中出现不带 `slug` 的 selector selection。
- sync 会通过 discover 展开匹配的 skills。
- 对应 `.claude/skills/skillhub-$TICIOU_TEST_NAMESPACE-<slug>/SKILL.md` 存在。
- lock entry 中保留 selector 信息。

检查：

```bash
cat .ticiou/config.yaml
find .ticiou/.runtime/skillhub-locks -type f -exec cat {} \;
find .claude/skills -maxdepth 3 -type f | sort
```

### 8.2 权限撤销或远端缺失

准备：

- 在 SkillHub 中选择一个当前已渲染的 private 或 namespace-only skill。
- 撤销当前 token 用户对该 skill 的访问，或临时下架/删除该 skill。

命令：

```bash
"$TICIOU_BIN" skill sync \
  --registry "$SKILLHUB_REGISTRY" \
  --token "$SKILLHUB_TOKEN"
```

预期结果：

- 403/401 时输出 warning：`is forbidden for the current token`。
- 404 时输出 warning：`is missing from the registry`。
- 对应 lock entry 状态变为 `forbidden` 或 `missing_remote`。
- 对应 `.claude/skills/skillhub-...` 渲染目录被 manifest stale cleanup 移除。
- `.ticiou/.runtime/skillhub-cache/` 可以保留旧 cache，但不会再被渲染。

### 8.3 离线 cache 回退

准备：

- 确保第 2 节或第 6 节已经成功渲染过至少一个 SkillHub skill。
- 暂停 SkillHub 服务，或把 registry 临时改成不可达地址。

命令：

```bash
"$TICIOU_BIN" use \
  -u "$(cat .ticiou/.runtime/current-profile)" \
  --registry "$SKILLHUB_REGISTRY" \
  --token "$SKILLHUB_TOKEN"
```

预期结果：

- 如果 lock/cache 已存在，命令输出 warning：`SkillHub registry unreachable; using cached ...`。
- 已缓存 skill 仍能渲染到 `.claude/skills/`。
- 如果删除对应 cache 后再执行，应明确失败或提示 cache missing，不能静默成功。

### 8.4 binary asset 渲染

准备：

- 第 0.4 节准备的测试 skill 已包含 `assets/logo.png`，可以直接用 `$TICIOU_TEST_REF` 测。

命令：

```bash
"$TICIOU_BIN" skill add "$TICIOU_TEST_REF" \
  --registry "$SKILLHUB_REGISTRY" \
  --token "$SKILLHUB_TOKEN"
```

预期结果：

- `.claude/skills/skillhub-$TICIOU_TEST_NAMESPACE-$TICIOU_TEST_SKILL/assets/logo.png` 存在。
- 二进制文件 byte-for-byte 保持一致。

可选检查：

```bash
shasum -a 256 "$TICIOU_TEST_ROOT/$TICIOU_TEST_SKILL/assets/logo.png"
shasum -a 256 ".claude/skills/skillhub-$TICIOU_TEST_NAMESPACE-$TICIOU_TEST_SKILL/assets/logo.png"
```

### 8.5 多用户 lock 切换

准备：

- 准备两个拥有 SkillHub selections 的用户 profile，例如用户 A 和用户 B。
- 两个用户都至少同步过一次 SkillHub skill。

命令：

```bash
"$TICIOU_BIN" use -u user-a --registry "$SKILLHUB_REGISTRY" --token "$SKILLHUB_TOKEN"
"$TICIOU_BIN" use -u user-b --registry "$SKILLHUB_REGISTRY" --token "$SKILLHUB_TOKEN"
find .ticiou/.runtime/skillhub-locks -type f | sort
```

预期结果：

- 用户切换不会出现 `SkillHub lock belongs to profile ...`。
- `.ticiou/.runtime/skillhub-locks/` 下按 profile/registry 分文件。
- 当前 rendered skills 与 active profile 一致。

## 9. 清理流程

### 9.1 clear user

命令：

```bash
cd /tmp/ticiou-manual-claude

"$TICIOU_BIN" clear user
"$TICIOU_BIN" status
```

预期结果：

- `clear user` 输出 `Cleared user profile resources`。
- `.ticiou/.runtime/current-profile` 被删除。
- `status` 中 `profile` 为 `(none)`。
- SkillHub/user 相关生成文件被清理。
- shared/platform 基础资源保留。

检查：

```bash
test ! -f .ticiou/.runtime/current-profile
find .claude -maxdepth 3 -type f | sort
```

### 9.2 clear all

命令：

```bash
"$TICIOU_BIN" clear all
"$TICIOU_BIN" status
```

预期结果：

- 输出 `Cleared all rendered Ticiou resources`。
- `generated files` 为 0。
- `.ticiou/config.yaml` 仍保留。
- 平台基础模板文件仍保留。
- `.ticiou/.runtime/skillhub-locks/` 被删除或为空。
- 旧版 `.ticiou/.runtime/skillhub-lock.json` 如存在也会被删除。

检查：

```bash
test -f .ticiou/config.yaml
cat .ticiou/.runtime/manifest.json
test ! -e .ticiou/.runtime/skillhub-lock.json
test ! -d .ticiou/.runtime/skillhub-locks || find .ticiou/.runtime/skillhub-locks -type f | sort
```

manifest 预期：

```json
{
  "version": 1,
  "files": []
}
```

## 10. 多平台流程

### 10.1 setup Claude + Copilot

命令：

```bash
rm -rf /tmp/ticiou-manual-both
mkdir -p /tmp/ticiou-manual-both
cd /tmp/ticiou-manual-both

"$TICIOU_BIN" setup \
  -p claude \
  -p copilot \
  --registry "$SKILLHUB_REGISTRY" \
  --token "$SKILLHUB_TOKEN" \
  --yes
```

预期结果：

- 输出 `Claude adapter installed`
- 输出 `Copilot adapter installed`
- 输出 `Authenticated SkillHub user <user>`
- 输出 `Activated Ticiou profile <user>`

如果选中了 SkillHub skills：

- `.claude/skills/skillhub-<namespace>-<slug>/SKILL.md` 存在。
- `.github/skills/skillhub-<namespace>-<slug>/SKILL.md` 存在。

检查：

```bash
find .claude -maxdepth 3 -type f | sort
find .github -maxdepth 3 -type f | sort
"$TICIOU_BIN" doctor
```

doctor 预期：

- Claude 检查通过。
- Copilot 目录检查通过。
- 输出 Copilot cloud agent 的提示：

```text
For Copilot cloud agent, run Ticiou at the repository root or pass --target git-root.
```

## 11. 非交互模式

### 11.1 非交互且未传 --yes

命令：

```bash
rm -rf /tmp/ticiou-manual-noninteractive
mkdir -p /tmp/ticiou-manual-noninteractive
cd /tmp/ticiou-manual-noninteractive

"$TICIOU_BIN" setup \
  -p claude \
  --registry "$SKILLHUB_REGISTRY" \
  --token "$SKILLHUB_TOKEN" < /dev/null
```

预期结果：

- 如果 SkillHub discover 返回至少一个 skill，命令失败。
- 错误包含：

```text
SkillHub setup requires skill selection
```

### 11.2 非交互且传 --yes

命令：

```bash
rm -rf /tmp/ticiou-manual-noninteractive-yes
mkdir -p /tmp/ticiou-manual-noninteractive-yes
cd /tmp/ticiou-manual-noninteractive-yes

"$TICIOU_BIN" setup \
  -p claude \
  --registry "$SKILLHUB_REGISTRY" \
  --token "$SKILLHUB_TOKEN" \
  --yes < /dev/null
```

预期结果：

- 命令成功。
- 启用 discover 到的全部 SkillHub skills。
- 输出 `Selected <n> SkillHub skill(s)`。

## 12. 3000 代理对比测试

### 12.1 使用后端 8080

命令：

```bash
rm -rf /tmp/ticiou-manual-8080
mkdir -p /tmp/ticiou-manual-8080
cd /tmp/ticiou-manual-8080

"$TICIOU_BIN" setup \
  -p claude \
  --registry http://localhost:8080 \
  --token "$SKILLHUB_TOKEN" \
  --yes
```

预期结果：

- 成功。

### 12.2 使用前端 3000

命令：

```bash
rm -rf /tmp/ticiou-manual-3000
mkdir -p /tmp/ticiou-manual-3000
cd /tmp/ticiou-manual-3000

"$TICIOU_BIN" setup \
  -p claude \
  --registry http://localhost:3000 \
  --token "$SKILLHUB_TOKEN" \
  --yes
```

预期结果：

- 如果 SkillHub web dev server 的 `/api` proxy 正常，命令成功。
- 如果失败而 8080 成功，说明 3000 前端代理不可用，不是 Ticiou client 问题。

## 13. 测试记录模板

| 编号 | 场景 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- | --- |
| 0.4.1 | 启动 SkillHub | `make dev-all` | 通过/失败 | |
| 0.4.2 | 生成 token | `POST /api/v1/tokens` | 通过/失败 | |
| 0.4.4 | 发布测试 skill | `POST /api/cli/v1/skills/.../publish` | 通过/失败 | |
| 0.4.5 | CLI API 消费检查 | `discover/resolve/download` | 通过/失败 | |
| 1.1 | 后端健康检查 | `curl -sf .../actuator/health` | 通过/失败 | |
| 1.2 | token whoami | `ticiou skillhub whoami ...` | 通过/失败 | |
| 1.4 | Ticiou help | `ticiou --help` | 通过/失败 | |
| 2.2 | Claude setup 主流程 | `ticiou setup -p claude ... --yes` | 通过/失败 | |
| 2.3 | Claude setup 交互选择 | `ticiou setup -p claude ...` | 通过/失败 | 可选 |
| 3.1 | status | `ticiou status` | 通过/失败 | |
| 3.2 | doctor | `ticiou doctor` | 通过/失败 | |
| 4.1 | 保存 token | `ticiou skillhub login ...` | 通过/失败 | |
| 4.2 | 交互保存 token | `ticiou setup ... --yes` | 通过/失败 | |
| 4.4 | 删除 token | `ticiou skillhub logout ...` | 通过/失败 | |
| 5.1 | skill list | `ticiou skill list --remote ...` | 通过/失败 | |
| 6.1 | skill add | `ticiou skill add ...` | 通过/失败 | |
| 6.2 | skill sync | `ticiou skill sync ...` | 通过/失败 | |
| 6.4 | skill remove | `ticiou skill remove ...` | 通过/失败 | |
| 7 | use 重渲染 | `ticiou use -u ...` | 通过/失败 | |
| 8.1 | selector selection | `ticiou skill add --namespace ... --label ...` | 通过/失败 | |
| 8.2 | 权限撤销/缺失 | `ticiou skill sync ...` | 通过/失败 | |
| 8.3 | 离线 cache 回退 | `ticiou use ...` | 通过/失败 | |
| 8.4 | binary asset | `ticiou skill add ...` | 通过/失败 | |
| 8.5 | 多用户 lock | `ticiou use -u user-a/user-b ...` | 通过/失败 | |
| 9.1 | clear user | `ticiou clear user` | 通过/失败 | |
| 9.2 | clear all | `ticiou clear all` | 通过/失败 | |
| 10.1 | 多平台 setup | `ticiou setup -p claude -p copilot ...` | 通过/失败 | |
| 11.1 | 非交互无 --yes | `setup ... < /dev/null` | 通过/失败 | |
| 11.2 | 非交互 --yes | `setup ... --yes < /dev/null` | 通过/失败 | |
| 12.2 | 3000 proxy | `--registry http://localhost:3000` | 通过/失败 | |
