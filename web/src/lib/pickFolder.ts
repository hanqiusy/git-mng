/** 打开系统文件夹选择对话框；取消则返回 null。 */
export async function pickFolder(defaultPath?: string): Promise<string | null> {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: defaultPath?.trim() || undefined,
      title: '选择文件夹',
    });
    if (typeof selected === 'string' && selected.trim()) return selected;
    return null;
  } catch {
    return null;
  }
}
