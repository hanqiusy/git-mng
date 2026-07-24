# GitHub 仓库管理工具 — 实现规格书

> 本文档是唯一权威的需求与设计输入。实现者（编码 CLI）必须严格按本文档交付，
> 不得擅自更换核心技术栈；如遇文档未覆盖的细节，按"合理且最简"原则处理并记录在 `NOTES.md`。

## 1. 产品概述

一个运行在本机的 GitHub 仓库管理工具（Tauri 单进程桌面客户端）：
用户用自己的 GitHub 账号（OAuth 授权登录，可选 PAT）登录后，可以浏览/搜索/筛选自己的仓库，
把任意仓库（自己的或全站搜索到的）克隆到本地一个或多个路径，对每个本地路径独立执行
推送 / 拉取 / 删除 / 一键重克隆，并妥善处理中国网络环境下的代理与 SSL 问题。

- 应用形态：Tauri 2 单 exe（无独立 server 进程）。
- 目标平台：Windows 10/11（必须兼容），代码尽量跨平台。
- 项目根目录：`D:\project\git-mng\app`（所有代码、测试、文档均放此目录内）。

## 2. 技术栈（固定，勿更换）

- 前端：Vite + React 18 + TypeScript + Tailwind CSS；经 Tauri `invoke` 调用后端。
- 后端：Rust（`src-tauri`），与 UI 同进程。
- 桌面壳：Tauri 2。
- Git 操作：Rust `std::process::Command` 调用系统 `git`，配置仅通过 `-c` 注入。
- GitHub API：`reqwest`，REST API v3，`Accept: application/vnd.github+json`，`X-GitHub-Api-Version: 2022-11-28`。
- 本地存储：JSON（`db.json`），默认系统用户应用数据目录（Windows `%APPDATA%\com.gitmng.desktop`；可用 `GIT_MNG_DATA_DIR` 覆盖）。
- 包管理：npm（前端）+ cargo（Rust）。

### 2.1 目录结构（目标形态）

```
.（仓库根）
  package.json            # scripts 见 §9
  README.md / SPEC.md / NOTES.md
  scripts/
    package-portable.mjs
    generate-icons.mjs
  src-tauri/              # Tauri 2 + Rust 业务后端（同进程）
    Cargo.toml
    tauri.conf.json
    capabilities/
    src/
      lib.rs, commands.rs, state.rs
      store.rs, proxy.rs, github.rs, gitops.rs, oauth.rs
  web/
    package.json
    vite.config.ts
    index.html
    src/
      main.tsx, App.tsx
      pages/ (Login, MyRepos, Search, Local, Settings)
      components/
      api.ts              # Tauri invoke 封装
```

## 3. 功能需求（必须全部实现）

### F1 登录 / 账号
- F1.1 主登录：GitHub OAuth Device Flow（「使用 GitHub 登录」→ 浏览器授权 → 轮询完成）。
  OAuth App Client ID 由 `GIT_MNG_GITHUB_CLIENT_ID` 或内置默认配置；scope：`repo`、`delete_repo`、`read:org`。
  备用：折叠的 Personal Access Token 登录（兼容旧用法）。
- F1.2 拿到 access token / 提交 PAT 后调用 `GET /user` 验证；失败给出明确错误（401/网络/SSL/授权取消）。
- F1.3 登录后显示当前用户头像与 login；支持退出登录（清除本地 token）。
- F1.4 access token 仅存本地 JSON 文件，绝不出现在任何日志/接口响应/前端持久化中；Device Flow 的 `device_code` 仅存服务端内存。

### F2 我的仓库列表
- F2.1 列出当前用户所有仓库（`GET /user/repos?affiliation=owner&per_page=100` 自动翻页取全）。
- F2.2 可见性筛选：全部 / 公有 / 私有。
- F2.3 搜索框：对名称与描述做前端即时过滤。
- F2.4 每项展示：名称、可见性徽章、语言、star 数、fork 数、默认分支、更新时间、是否已有本地克隆标记。
- F2.5 排序：最近更新优先；提供按名称/star 排序切换。

### F3 全站搜索
- F3.1 使用 `GET /search/repositories?q=...` 全站搜索任意仓库，支持按 stars 排序、分页（上一页/下一页）。
- F3.2 搜索结果同样可直接克隆到本地（克隆他人仓库时推送按钮置灰并提示"非本人仓库，推送可能无权限"）。

### F4 克隆（拉取）到本地
- F4.1 克隆对话框字段：
  - 目标路径（打开对话框时自动填入 `<默认根目录>/<repo>`，不添加 owner 等前缀；仍可手动编辑或重新生成）；
  - 分支 / 标签选择（下拉，数据来自 `GET /repos/{owner}/{repo}/branches` 与 `/tags`，默认选中默认分支）；
  - 浅克隆选项（`--depth 1`，默认不勾选）。
- F4.2 同一仓库允许克隆到多个不同路径；路径重复（已存在且非空目录）时拒绝并提示改用独立的“链接本地文件夹”功能，克隆流程不再隐式切换为链接。
- F4.3 克隆使用 HTTPS URL，并在 URL 中注入 token（`https://x-access-token:<token>@github.com/...`）以支持私有仓库；**严禁**把带 token 的 URL 写入前端显示或日志（日志中需脱敏为 `***`）。
- F4.4 克隆过程中显示进行中状态；失败时展示 git stderr（脱敏后）。

### F5 本地克隆管理
- F5.1 "本地"页按仓库分组列出所有本地路径（一个仓库 N 个路径都要显示）。
- F5.2 每个路径卡片显示：路径、当前分支、状态（未提交改动数、ahead/behind 计数——用
  `git status --porcelain` 与 `git rev-list --left-right --count HEAD...@{upstream}`，失败时降级显示"未知"）、最后提交摘要。
- F5.2.1 自动读取本地与远端分支，进入页面后后台执行 `git fetch --prune origin` 更新远端引用；
  展示各分支的提交、upstream、ahead/behind；同步时不发光，存在差异时仅在具体分支行内
  使用小范围不同颜色的内发光，并明确标记本地较新、远端较新或已分叉。
- F5.2.2 分支拓扑树通过按钮打开弹窗，仅显示当前本地分支与对应远端分支的最新节点，
  保留 Git 日志式纵向分支线，中间与更早提交使用省略号节点表示；点击省略节点可在原位置
  展开被压缩的提交，再次点击收起，不在列表页直接展开。
- F5.2.3 本地路径文本可点击并直接打开对应目录。
- F5.2.4 仓库名称可点击并交给系统浏览器打开对应 GitHub 仓库网页。
- F5.3 每个路径独立操作：
  - **推送** `git push`（支持当前分支；无 upstream 时 `git push -u origin <branch>`）；
  - **拉取** `git pull --ff-only`；
  - **打开目录**（Windows 用 `explorer.exe`，跨平台降级）；
  - **删除本地**（二次确认后删除目录，映射记录一并移除；远程仓库不受影响）；
  - **一键删除重新拉取**（二次确认；删除目录后按原分支/标签重新克隆到同一路径）。
- F5.4 仓库级操作：删除远程仓库（二次确认 + 输入仓库名验证，`DELETE /repos/{owner}/{repo}`，仅自己的仓库显示此按钮）。
- F5.5 补充：star / unstar 任意仓库（`PUT/DELETE /user/starred/{owner}/{repo}`）。
- F5.6 本地管理支持“新建本地 + GitHub 仓库”：在默认克隆根目录创建同名文件夹，同时创建同名 GitHub 空仓库，初始化本地 Git/main 并连接 origin；默认私有，可切换公有。
- F5.7 “链接本地文件夹”与克隆分离：只接受已存在文件夹，不下载、移动或覆盖文件；已有 Git 仓库时校验/补充 origin，未初始化 Git 时必须二次确认后才初始化并连接。
- F5.8 GitHub 空仓库同样支持克隆和链接；克隆时若远端没有分支，不传 `--branch` 参数。

### F6 代理与 SSL（重点）
- F6.1 代理模式三档（设置页可选，默认"系统代理"）：
  1. **系统代理**：Windows 下读取注册表
     `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 的
     `ProxyEnable`/`ProxyServer`（用 `reg query` 解析，勿依赖第三方模块）；非 Windows 读
     `HTTPS_PROXY`/`https_proxy`/`HTTP_PROXY` 环境变量。
  2. **自定义**：用户填 `http://host:port`。
  3. **直连**：不使用代理。
- F6.2 GitHub API 请求：有代理时使用 undici `ProxyAgent`（把 undici 列为 server 依赖）；
  无代理走默认 fetch。所有 API 错误需区分：HTTP 状态错误 / 网络错误 / SSL 证书错误，并给出中文提示。
- F6.3 git 命令：每次 spawn git 时按当前设置注入
  `-c http.proxy=<proxy>`（或 `-c http.proxy=` 清空），**不写入用户全局 git config**。
- F6.4 SSL 报错治理（默认策略，解决 `SSL certificate problem: unable to get local issuer certificate`）：
  - Windows 默认注入 `-c http.sslBackend=schannel`（走系统证书库，兼容企业代理根证书）；
  - 设置页提供开关："跳过 SSL 校验"（`-c http.sslVerify=false`，默认关闭，UI 标注风险）。
- F6.5 GitHub API 侧如用户开启"跳过 SSL 校验"，对应 `NODE_TLS_REJECT_UNAUTHORIZED=0` 仅作用于
  server 进程内 dispatcher（undici Agent `connect: { rejectUnauthorized: false }`），不得污染全局环境变量文件。

### F7 体验与健壮性
- F7.1 所有耗时操作（克隆/推送/拉取/删除）有 loading 与成功/失败 toast；失败信息可读（中文概述 + 可展开的原始 stderr）。
- F7.2 后端所有接口统一错误格式 `{ "error": { "code": "...", "message": "...", "detail"?: "..." } }`。
- F7.3 无独立 HTTP API 端口；桌面开发时 Vite 由 `beforeDevCommand` 拉起（默认 5173），生产由 WebView 加载打包前端并通过 `invoke` 调 Rust。
- F7.4 `GET /api/health` 返回 `{ "ok": true }`。
- F7.5 操作日志：server 内存中保留最近 100 条操作记录（时间、动作、目标、结果），`GET /api/logs` 可查看（token 必须脱敏）。

## 4. REST API 设计（server 提供，前端消费）

```
POST   /api/auth/device/start {} -> { sessionId, userCode, verificationUri, ... }
POST   /api/auth/device/poll  { sessionId } -> { status, user? }  Device Flow 轮询
POST   /api/auth/login        { token } -> { user }        备用 PAT 登录
POST   /api/auth/logout
GET    /api/auth/me           -> { user } | 401
GET    /api/repos?visibility=all|public|private&q=
GET    /api/search?q=&sort=stars&page=1
GET    /api/repos/:owner/:repo/branches
GET    /api/repos/:owner/:repo/tags
POST   /api/repos             { name, description?, private }   新建仓库
DELETE /api/repos/:owner/:repo                                  删除远程仓库
PUT    /api/repos/:owner/:repo/star
DELETE /api/repos/:owner/:repo/star
GET    /api/clones                                            本地映射+各路径 git 状态
POST   /api/clones            { owner, repo, path, ref, refType: "branch"|"tag", shallow }
DELETE /api/clones            { path }                        删除本地目录+记录
POST   /api/clones/reclone    { path }                        一键删除重拉
POST   /api/clones/push       { path }
POST   /api/clones/pull       { path }
POST   /api/clones/open       { path }                        打开资源管理器
GET    /api/settings
PUT    /api/settings          { proxyMode, customProxy, sslVerify, defaultCloneRoot }
GET    /api/logs
GET    /api/health
```

## 5. UI 要求

- 左侧导航：我的仓库 / 全站搜索 / 本地管理 / 设置；顶栏右侧显示当前用户与退出。
- 未登录时仅显示登录页。
- 风格：简洁深色或浅色均可，信息密度适中，中文界面。
- 主窗口默认宽度约 820px，可调整大小；紧凑布局下保持主要操作可用。
- 左侧导航与应用外壳固定，仅右侧主内容区滚动；普通内容卡片避免嵌套滚动条。
- 克隆对话框、删除确认框为模态框。
- 本地路径卡片的状态徽章：干净(绿) / 有改动(黄) / 领先远程(蓝) / 落后远程(紫) / 未知(灰)。

## 6. 数据模型（data/db.json）

```jsonc
{
  "token": "ghp_xxx",            // 仅服务端读写
  "settings": {
    "proxyMode": "system",       // system | custom | none
    "customProxy": "",
    "sslVerify": true,           // false = 跳过校验
    "defaultCloneRoot": "D:\\github-clones"
  },
  "clones": [
    {
      "owner": "octocat",
      "repo": "hello-world",
      "fullName": "octocat/hello-world",
      "private": false,
      "paths": [
        { "path": "D:\\github-clones\\hello-world",
          "ref": "main", "refType": "branch", "addedAt": "2026-07-22T12:00:00Z" }
      ]
    }
  ]
}
```

## 7. 安全红线（评审必查）

1. token 不出现在：任何 API 响应体、前端 localStorage、控制台/日志、git stderr 透传文本中（统一替换为 `***`）。
2. 删除类接口（本地目录、远程仓库）服务端必须校验参数合法性（路径非空、owner 必须等于当前登录用户才能删远程）。
3. 不向用户全局 git config 写任何配置；所有 git 配置通过命令行 `-c` 注入。
4. 克隆命令的 path 必须规范化并拒绝空路径与磁盘根路径（如 `C:\`）。

## 8. 验收清单（实现者自验 + 评审者复核）

- [ ] `npm install` 一次装完（root）。
- [ ] `npm run build` 通过（web vite build）。
- [ ] `npm run dev` 弹出 Tauri 窗口（Vite 由 beforeDevCommand 拉起）；业务经 invoke，无独立 server 进程。
- [ ] `npm run build:desktop` 产出便携目录 `dist-portable/git-mng/`，其中仅有 `git-mng.exe`（无 `*-server.exe`）。
- [ ] OAuth 登录、仓库列表、克隆/推送/拉取、设置代理可用。
- [ ] token 仅存本机 JSON，不进前端持久化/日志明文。
- [ ] `NOTES.md` 记录实现取舍与已知限制。

## 9. npm scripts（root package.json）

```jsonc
{
  "scripts": {
    "dev": "tauri dev",
    "dev:web": "npm run dev -w web -- --host 127.0.0.1",
    "build": "npm run build -w web",
    "build:desktop": "tauri build --no-bundle && node scripts/package-portable.mjs",
    "package:portable": "node scripts/package-portable.mjs"
  }
}
```

- 桌面开发前置：Rust（rustup）+ Windows MSVC Build Tools + WebView2。

## 10. 实现步骤建议

1. 初始化 monorepo 与依赖；2) Rust：store → proxy → github → gitops → oauth → commands；
3) web：api 封装（invoke）→ 登录 → 我的仓库 → 搜索 → 本地管理 → 设置；
4) 拆除 sidecar；5) `build:desktop` 自验（§8）；6) 写 NOTES.md。
