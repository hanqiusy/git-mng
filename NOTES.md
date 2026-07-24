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

## 克隆与链接

- 克隆与链接已有文件夹使用两个独立入口；克隆目标非空时直接拒绝，不再在克隆弹窗中隐式切换为关联。
- 链接只处理已存在文件夹：已有 Git 时校验或补充 origin；没有 Git 时先询问，确认后初始化且保留全部现有文件。
- 空 GitHub 仓库没有分支时，克隆不指定 `--branch`，避免把默认分支名误传给 git。
- 默认克隆根目录支持文件夹选择对话框。
- 打开克隆对话框时自动填入 `<默认根目录>/<仓库名>`，不再添加 owner 前缀。
- 本地管理可在默认根目录新建同名文件夹与 GitHub 空仓库，默认私有，并自动完成 Git 初始化和 origin 连接。

## 分支状态

- 本地管理页先读取本地缓存的本地/远端引用，再后台执行 `git fetch --prune origin`，避免网络请求阻塞首屏。
- 每个路径展示本地分支、远端分支、upstream、ahead/behind；同步时不发光，存在差异时才在分支行内做小范围蓝青/紫色/琥珀色内发光，并标明本地较新、远端较新或已分叉。
- 分支树按需在弹窗中显示，保持 Git 日志式纵向分支线，只保留当前本地分支和对应远端分支的最新提交节点；中间与更早历史默认用省略号节点压缩，点击省略节点可展开/再次点击收起（最多读取最近 80 条提交）。
- 远端同步失败时保留缓存分支信息并显示失败提示，不影响本地操作。
- 仓库标题可交给系统浏览器直接打开 GitHub 仓库网页。
- 本地路径文本可点击并直接打开目录。

## 窗口布局

- 桌面主窗口默认宽度由 1200px 调整为 820px（最小 720px），侧栏和内容留白同步收紧。
- 应用外壳与左侧导航固定，仅右侧主内容区滚动；分支列表不再产生嵌套滚动条。

## 已知限制

- 系统代理检测主要覆盖 Windows 注册表与环境变量。
- 本地克隆列表会对每个路径跑 git 状态，路径很多时可能较慢。
- 删除远程仓库需要 token 具备 `delete_repo` scope。
- OAuth App 必须启用 Device Flow。
