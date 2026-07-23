# NOTES.md — 实现取舍与已知限制

## 当前形态（Tauri + Rust 内嵌）

- 单进程桌面应用；业务在 `src-tauri`（store / proxy / github / gitops / oauth / commands）。
- 前端经 `@tauri-apps/api` `invoke` 调用，无独立 HTTP API / sidecar。
- 开发：`npm run dev` = `tauri dev`（Vite 由 `beforeDevCommand` 拉起）。
- 打包：`npm run build:desktop` → `dist-portable/git-mng/git-mng.exe`。

## 登录与账号

- 主登录：GitHub OAuth Device Flow；Client ID 默认公开配置，可用 `GIT_MNG_GITHUB_CLIENT_ID` 覆盖。
- 支持保存多账号、一键登录、登录后切换；`settings.autoLogin` 控制启动自动登录。
- 「退出登录」不删除凭证；「删除凭证」才清除。
- Token 存用户数据目录 `db.json`，不进前端持久化；日志脱敏。

## 网络与 Git

- 代理：系统 / 自定义 / 直连；登录页与设置页均可配置；支持 `socks5://`。
- HTTP 客户端带超时与有限重试。
- Git 配置仅通过命令行 `-c` 注入，不改全局 gitconfig。
- Windows 子进程使用 `CREATE_NO_WINDOW`，避免控制台闪窗。

## 克隆

- 目标目录已存在且非空时，提示是否关联（校验 origin 是否为对应仓库）。
- 默认克隆根目录支持文件夹选择对话框。

## 已知限制

- 系统代理检测主要覆盖 Windows 注册表与环境变量。
- 本地克隆列表会对每个路径跑 git 状态，路径很多时可能较慢。
- 删除远程仓库需要 token 具备 `delete_repo` scope。
- OAuth App 必须启用 Device Flow。
