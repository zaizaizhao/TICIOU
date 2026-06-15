<div align="center">

# 提效 Ticiou

**把团队 AI Coding 能力沉淀成可发布、可审查、可复用的工程资产。**

Claude / Copilot profile compiler for teams.

</div>

<br />

> **核心理念**
> AI Coding 的真正提效，不来自每个人各自攒 prompt，而来自把团队经验产品化。


> 提效把共享规范、个人习惯、平台适配和运行状态拆开：团队共同维护 profile 源码，通过 CI 发布 CLI；开发者在任意项目里执行一条命令，就能获得一致、可回滚、可诊断的 AI 工具配置。
>


## 为什么需要它

团队里的 AI 配置通常会慢慢散落：

- 公共规范在某个仓库里。
- 个人 prompt 在本机。
- Claude、Copilot 的目录结构不同。
- 换项目、换机器、换同事时，很难保持一致。

提效把这些资源收拢成可发包、可审查、可复用的 profile：

```text
profiles/
  shared/            # 团队共享能力
  users/kaibin.xu/   # 个人能力
  users/yanan.zhao/
```

执行 `ticiou setup -u kaibin.xu -p claude` 时，Ticiou 会初始化项目、安装平台 adapter，并把 `shared` 和该用户目录下的资源渲染到当前项目的 `.claude/` 或 `.github/` 中。
Claude 的用户级 skills 会以本项目 local plugin 方式启用，避免个人上下文作为项目 skill 泄漏到仓库配置中。

## 支持什么

- Claude Code 项目级配置
- GitHub Copilot / Copilot CLI 项目级配置
- 多用户 profile 切换
- SkillHub 远端 skills 选择、锁定、下载和同步
- skills、hooks、agents、commands、prompts
- manifest 安全写入，避免覆盖非 Ticiou 生成的文件

## 快速开始

安装 CLI 后，在任意项目目录执行：

```bash
cd your-project

ticiou setup -u kaibin.xu -p claude
ticiou doctor
```

这会在当前目录生成：

```text
.ticiou/    # 本项目的运行状态和 manifest
.claude/    # Claude 可读取的配置
```

Claude user profile skills 会生成到 `.ticiou/.runtime/claude-plugin-marketplace/`，并由 `ticiou use` 自动执行 Claude Code 的 local plugin 注册/安装流程：

```text
profiles/users/kaibin.xu/skills/personal/SKILL.md
  -> /ticiou-kaibin-xu:personal
```

这会写入 `.claude/settings.local.json`，并在 Claude Code 的本机 plugin cache 中安装当前项目的 local plugin。该文件是本机状态，不应提交到业务仓库。

共享 skills 仍保持项目级扁平输出：

```text
profiles/shared/skills/azure-devops/SKILL.md
  -> .claude/skills/ticiou-shared-azure-devops/SKILL.md
  -> /ticiou-shared-azure-devops
```

### 使用 SkillHub skills

Ticiou 可以直接连接 SkillHub registry，不依赖 `skillhub` CLI 二进制。登录后把远端 skill 加入当前用户 profile，`ticiou use` 和 `ticiou skill sync` 会按 lock 文件下载并渲染到已启用的平台目录。

```bash
ticiou skillhub login --registry http://localhost:3000
ticiou skill list --remote --namespace emrois --owner self --label active
ticiou skill add emrois/api-review
ticiou use -u kaibin.xu
ticiou skill sync
```

本地开发时，`http://localhost:3000` 通常由 SkillHub web dev server 代理到后端；如果只启动后端 API，可以传 `--registry http://localhost:8080`。

凭据只保存在用户目录，不写入项目文件：

```text
~/.ticiou/skillhub-credentials.json
```

项目内只保存 selection、lock 和缓存：

```text
.ticiou/config.yaml
.ticiou/.runtime/skillhub-lock.json
.ticiou/.runtime/skillhub-cache/
```

常用认证和同步参数：

```bash
ticiou skillhub login --registry http://localhost:3000 --token sk_xxx
SKILLHUB_TOKEN=sk_xxx ticiou skillhub whoami --registry http://localhost:3000
ticiou skillhub whoami --ask-token
ticiou skill list --remote --anonymous
ticiou use -u kaibin.xu --registry http://localhost:3000 --token sk_xxx
ticiou use -u kaibin.xu --ask-token
ticiou use -u kaibin.xu --anonymous
ticiou skill sync --frozen
```

`--token` 只用于当前命令；`SKILLHUB_TOKEN` 优先于本机凭据；`--ask-token` 允许交互粘贴 token；`--anonymous` 只访问公开 skills；`--frozen` 只检查远端状态，不写 lock、缓存或渲染文件。

也可以加入 selector，让 profile 跟踪一组远端 skills：

```bash
ticiou skill add --namespace emrois --owner self --label active
```

生成的 `.ticiou/config.yaml` 会记录当前用户的 SkillHub selection，例如：

```yaml
profiles:
  users:
    kaibin.xu:
      skillhub:
        registry: http://localhost:3000
        auto_refresh: false
        background_check: true
        update_policy: prompt
        new_skill_policy: prompt
        deleted_skill_policy: keep-cache
        selections:
          - namespace: emrois
            slug: api-review
            policy: auto
```

历史打包在 Ticiou 源码里的 profile skills 仍默认启用，以兼容现有团队使用方式。需要迁移到纯 SkillHub 远端 skills 时，可以在 `.ticiou/config.yaml` 中关闭：

```yaml
render:
  legacy_packaged_skills: false
```

启用 Copilot：

```bash
ticiou setup -u kaibin.xu -p copilot
```

同时启用 Claude 和 Copilot：

```bash
ticiou setup -u kaibin.xu -p claude -p copilot
```

如需把 `.github/` 写到 Git 仓库根目录：

```bash
ticiou setup -u kaibin.xu -p copilot --target git-root
```

## 命令

```bash
ticiou init
```

初始化当前目录的 `.ticiou/` 运行配置。

```bash
ticiou setup -u <user> -p <platform>
```

一键完成 `ticiou init`、`ticiou install <platform>` 和 `ticiou use -u <user>`。可重复传入 `-p` 同时安装多个平台，例如 `ticiou setup -u kaibin.xu -p claude -p copilot`。

```bash
ticiou install claude
ticiou install copilot
```

安装平台 adapter，并在 `.ticiou/config.yaml` 中启用对应平台。

```bash
ticiou use -u <user>
```

激活用户 profile，渲染团队共享资源和当前用户资源；如果该用户配置了 SkillHub selections，会同步 lock/cache 并渲染远端 skills。支持 `--registry`、`--token`、`--ask-token`、`--anonymous` 和 `--frozen`。

```bash
ticiou skillhub login --registry <url>
ticiou skillhub whoami --registry <url>
ticiou skillhub logout --registry <url>
```

保存、查看或删除当前机器上的 SkillHub token。`login` 可传 `--token` 或读取 `SKILLHUB_TOKEN`，未传 token 且终端可交互时会提示输入。

```bash
ticiou skill list --remote
```

列出远端 SkillHub skills，可使用 `--namespace`、`--owner self`、`--label` 和 `--query` 过滤。

```bash
ticiou skill add <namespace>/<slug>
ticiou skill add --namespace <namespace> --owner self --label <label>
ticiou skill remove <namespace>/<slug>
ticiou skill sync
```

把远端 skill 或 selector 加入当前用户 profile，移除 explicit selection，或同步当前 profile 的远端 skills。`skill sync --frozen` 适合 CI 检查，不会修改 lock、缓存或渲染文件。

```bash
ticiou clear user
```

清除当前用户 profile 渲染到项目中的资源，并保留 shared 资源。

```bash
ticiou clear all
```

清除当前项目中所有 Ticiou 渲染资源，包括 shared 和当前用户资源；保留 `.ticiou/config.yaml` 和平台基础模板。

```bash
ticiou status
```

查看当前目录的 target、active profile、启用平台和生成文件数量。

```bash
ticiou doctor
```

检查平台目录、hooks、manifest、active profile 是否一致。

CLI 会用彩色状态点、命令标题和下一步提示展示结果；在设置 `NO_COLOR=1` 或不支持颜色的终端中会自动降级为纯文本。

## 本地开发使用

```bash
pnpm install
pnpm run build
```

直接从任意目标项目调用本地构建产物：

```bash
cd your-project
node /path/to/Ticiou/dist/cli/index.js setup -u kaibin.xu -p claude
```

或者使用 `npm link`：

```bash
cd /path/to/Ticiou
npm link

cd your-project
ticiou setup -u kaibin.xu -p claude
```

源码变更后重新构建：

```bash
pnpm run build
```

## 工作原理

Ticiou 会把两个位置分开：

```text
CLI 包内资源       -> dist/profiles, dist/templates
当前项目输出目录   -> .ticiou, .claude, .github
```

当你在某个项目中执行命令时，Ticiou 使用当前工作目录作为目标目录：

```bash
cd service-a
ticiou use -u kaibin.xu
```

只会影响 `service-a`。

```bash
cd service-b
ticiou use -u kaibin.xu
```

只会影响 `service-b`。

切换用户时，Ticiou 根据 `.ticiou/.runtime/manifest.json` 删除上一轮仍归 Ticiou 管理的旧文件，并同步 Claude local plugin 安装与配置，保证当前项目只加载当前用户的资源。

## 维护方式

推荐团队共同维护 Ticiou 源码仓库：

1. 在 `profiles/shared` 维护团队共享能力。
2. 在 `profiles/users/<user>` 维护个人能力。
3. 通过 CI 构建并发布 npm 包。
4. 开发者升级 CLI 后，在自己的项目里执行 `ticiou setup -u <user> -p <platform>`。

这样配置可以被 review、版本化和回滚，同时不会把每个人的私有激活状态提交到业务仓库。

## 开发命令

```bash
pnpm run typecheck
pnpm test
pnpm run build
```
