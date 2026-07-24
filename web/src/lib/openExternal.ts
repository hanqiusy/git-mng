/** 在 Tauri 中交给系统浏览器打开；普通 Web 环境降级到新窗口。 */
export async function openExternal(url: string) {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      const { open } = await import('@tauri-apps/plugin-shell');
      await open(url);
      return;
    } catch {
      /* 插件不可用时降级 */
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}
