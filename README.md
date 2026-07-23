# GitHub 仓库管理工具（git-mng）

本机桌面客户端：浏览/搜索 GitHub 仓库，克隆到本地并管理推送/拉取；支持代理与多账号。

## 技术栈

- 桌面壳：Tauri 2（单进程）
- 后端：Rust（`src-tauri`，`invoke` 命令）
- 前端：Vite + React 18 + TypeScript + Tailwind

## 环境要求

- Node.js 18+
- Rust（rustup）+ Windows MSVC Build Tools
- WebView2（Win10/11 通常自带）
- 系统已安装 Git

## 开发

```bash
npm install
npm run dev
```

## 打包便携版

```bash
npm run build:desktop
```

产物目录：`dist-portable/git-mng/git-mng.exe`

## 说明

- 登录凭证保存在用户数据目录（Windows：`%APPDATA%\com.gitmng.desktop\db.json`）
- OAuth Client ID 可用环境变量 `GIT_MNG_GITHUB_CLIENT_ID` 覆盖
- 数据目录可用 `GIT_MNG_DATA_DIR` 覆盖
- 详细需求见 [SPEC.md](./SPEC.md)，实现取舍见 [NOTES.md](./NOTES.md)
