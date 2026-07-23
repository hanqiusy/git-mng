/**
 * 便携目录：仅 git-mng.exe（Rust 内嵌后端，无 sidecar）
 * 输出：dist-portable/git-mng/
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const releaseDir = path.join(root, 'src-tauri', 'target', 'release');
const portableRoot = path.join(root, 'dist-portable');
const outDir = path.join(portableRoot, 'git-mng');
const exeName = 'git-mng.exe';
const exeSrc = path.join(releaseDir, exeName);

if (!fs.existsSync(exeSrc)) {
  console.error('[package-portable] missing:', exeSrc);
  console.error('请先执行: npm run build:desktop');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
const exeDst = path.join(outDir, exeName);
try {
  fs.copyFileSync(exeSrc, exeDst);
} catch (err) {
  // 目标被占用时先删再拷；仍失败则提示关闭正在运行的程序
  try {
    fs.rmSync(exeDst, { force: true });
    fs.copyFileSync(exeSrc, exeDst);
  } catch {
    console.error('[package-portable] 无法覆盖', exeDst);
    console.error('请先关闭正在运行的 git-mng.exe 后重试。');
    console.error(err);
    process.exit(1);
  }
}

const readme = `GitHub 仓库管理工具（便携版）

启动：双击 git-mng.exe

说明：
- 单文件入口，无需 server.exe / Node
- 需要本机已安装 Git
- 登录将打开浏览器完成 GitHub 授权
- 登录凭证保存在用户数据目录：%APPDATA%\\com.gitmng.desktop\\db.json
`;
fs.writeFileSync(path.join(outDir, 'README.txt'), readme, 'utf8');

console.log('[package-portable] ready:', outDir);
console.log('[package-portable] launch:', path.join(outDir, exeName));
