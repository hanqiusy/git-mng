import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AccountInfo, LogEntry, Settings } from '../api';
import Modal from '../components/Modal';
import { Badge, Btn, Empty } from '../components/ui';
import { useToast } from '../components/Toast';
import { formatTime } from '../components/RepoCard';
import { pickFolder } from '../lib/pickFolder';

type ProxyMode = Settings['proxyMode'];

const PROXY_OPTIONS: { key: ProxyMode; label: string; hint: string }[] = [
  { key: 'system', label: '系统代理', hint: 'Windows 读注册表，其他平台读 HTTPS_PROXY 等环境变量' },
  { key: 'custom', label: '自定义', hint: 'http://host:port 或 socks5://host:port' },
  { key: 'none', label: '直连', hint: '不使用任何代理' },
];

/** F6 设置（代理/SSL/默认克隆根目录） + F7.5 操作日志 */
export default function Settings({
  onCredentialsCleared,
  onAccountsChanged,
}: {
  onCredentialsCleared: () => void;
  onAccountsChanged?: () => void;
}) {
  const toast = useToast();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [logs, setLogs] = useState<LogEntry[] | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const loadAccounts = async () => {
    try {
      const s = await api.listAccounts();
      setAccounts(s.accounts);
    } catch {
      setAccounts([]);
    }
  };

  useEffect(() => {
    api
      .getSettings()
      .then(({ settings }) => setSettings(settings))
      .catch((err) => toast.error(err, '设置加载失败'));
    void loadAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadLogs = async () => {
    setLogsLoading(true);
    try {
      const { logs } = await api.getLogs();
      setLogs(logs);
    } catch (err) {
      toast.error(err, '日志加载失败');
    } finally {
      setLogsLoading(false);
    }
  };

  useEffect(() => {
    loadLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const { settings: saved } = await api.updateSettings(settings);
      setSettings(saved);
      toast.success('设置已保存');
    } catch (err) {
      toast.error(err, '保存设置失败');
    } finally {
      setSaving(false);
    }
  };

  const clearCredentials = async () => {
    setClearing(true);
    try {
      await api.clearCredentials();
      setConfirmClear(false);
      setAccounts([]);
      toast.success('已删除全部本地登录凭证');
      onCredentialsCleared();
    } catch (err) {
      toast.error(err, '删除凭证失败');
    } finally {
      setClearing(false);
    }
  };

  const removeOne = async (id: string) => {
    setRemovingId(id);
    try {
      await api.removeAccount(id);
      const s = await api.listAccounts();
      setAccounts(s.accounts);
      onAccountsChanged?.();
      toast.success('已移除该账号凭证');
      if (s.accounts.length === 0) onCredentialsCleared();
    } catch (err) {
      toast.error(err, '移除账号失败');
    } finally {
      setRemovingId(null);
    }
  };

  if (!settings) return null;

  return (
    <div className="max-w-3xl space-y-6">
      {/* 账号与凭证 */}
      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-800">账号与凭证</h2>
        <p className="mt-2 text-sm text-slate-600">
          多账号凭证保存在用户数据目录。退出登录不会删除凭证；可在此移除单个或全部账号。
        </p>
        <ul className="mt-4 space-y-2">
          {accounts.length === 0 ? (
            <li className="text-sm text-slate-400">暂无已保存账号</li>
          ) : (
            accounts.map((acc) => (
              <li
                key={acc.id}
                className="flex items-center gap-3 rounded-md border border-slate-100 px-3 py-2"
              >
                {acc.avatarUrl ? (
                  <img src={acc.avatarUrl} alt="" className="h-8 w-8 rounded-full" />
                ) : (
                  <span className="h-8 w-8 rounded-full bg-slate-200" />
                )}
                <span className="min-w-0 flex-1 truncate text-sm text-slate-700">@{acc.login}</span>
                <Btn
                  variant="danger"
                  loading={removingId === acc.id}
                  onClick={() => void removeOne(acc.id)}
                >
                  移除
                </Btn>
              </li>
            ))
          )}
        </ul>
        <div className="mt-4">
          <Btn variant="danger" onClick={() => setConfirmClear(true)} disabled={accounts.length === 0}>
            删除全部凭证
          </Btn>
        </div>
      </section>

      <Modal
        title="删除全部凭证"
        open={confirmClear}
        onClose={() => !clearing && setConfirmClear(false)}
        footer={
          <>
            <Btn onClick={() => setConfirmClear(false)} disabled={clearing}>
              取消
            </Btn>
            <Btn variant="danger" loading={clearing} onClick={clearCredentials}>
              确认删除
            </Btn>
          </>
        }
      >
        <p className="text-sm text-slate-700">
          将清除本机保存的全部 GitHub 账号凭证，并退出当前会话。克隆路径与代理设置会保留。
        </p>
      </Modal>

      {/* F6 代理与 SSL */}
      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-800">代理与 SSL</h2>

        <div className="mt-4 space-y-2">
          <p className="text-sm font-medium text-slate-700">代理模式</p>
          {PROXY_OPTIONS.map((opt) => (
            <label key={opt.key} className="flex items-start gap-2 text-sm text-slate-700">
              <input
                type="radio"
                name="proxyMode"
                className="mt-1"
                checked={settings.proxyMode === opt.key}
                onChange={() => setSettings({ ...settings, proxyMode: opt.key })}
              />
              <span>
                {opt.label}
                <span className="ml-2 text-xs text-slate-400">{opt.hint}</span>
              </span>
            </label>
          ))}
          {settings.proxyMode === 'custom' && (
            <input
              className="ml-6 w-72 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
              placeholder="http://127.0.0.1:7890"
              value={settings.customProxy}
              onChange={(e) => setSettings({ ...settings, customProxy: e.target.value })}
            />
          )}
        </div>

        <div className="mt-5 space-y-1">
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={!settings.sslVerify}
              onChange={(e) => setSettings({ ...settings, sslVerify: !e.target.checked })}
            />
            跳过 SSL 校验（git 使用 -c http.sslVerify=false）
          </label>
          {!settings.sslVerify && (
            <p className="ml-6 text-xs text-rose-600">
              ⚠ 风险提示：跳过 SSL 校验会失去对中间人攻击的防护，仅在确认网络环境可信时使用。
            </p>
          )}
          <p className="ml-6 text-xs text-slate-400">
            默认策略：Windows 下 git 走系统证书库（schannel），一般无需开启此项。
          </p>
        </div>

        <div className="mt-5">
          <label className="mb-1 block text-sm font-medium text-slate-700">默认克隆根目录</label>
          <div className="flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
              placeholder="D:\github-clones"
              value={settings.defaultCloneRoot}
              onChange={(e) => setSettings({ ...settings, defaultCloneRoot: e.target.value })}
            />
            <Btn
              type="button"
              onClick={() => {
                void (async () => {
                  const dir = await pickFolder(settings.defaultCloneRoot);
                  if (dir) setSettings({ ...settings, defaultCloneRoot: dir });
                })();
              }}
            >
              选择文件夹
            </Btn>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            克隆对话框中「默认根目录生成」将使用此目录。
          </p>
        </div>

        <div className="mt-5">
          <Btn variant="primary" loading={saving} onClick={save}>
            保存设置
          </Btn>
        </div>
      </section>

      {/* F7.5 操作日志 */}
      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-800">操作日志（最近 100 条）</h2>
          <Btn onClick={loadLogs} loading={logsLoading}>
            刷新
          </Btn>
        </div>
        <div className="mt-3">
          {logs === null ? (
            <Empty text="加载中…" />
          ) : logs.length === 0 ? (
            <Empty text="暂无操作日志" />
          ) : (
            <ul className="divide-y divide-slate-100 text-sm">
              {logs.map((log, i) => (
                <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <span className="text-xs text-slate-400">{formatTime(log.time)}</span>
                  <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{log.action}</code>
                  <span className="min-w-0 flex-1 break-all text-slate-700">{log.target}</span>
                  <Badge
                    color={
                      log.ok ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'
                    }
                  >
                    {log.ok ? '成功' : '失败'}
                  </Badge>
                  {log.detail && (
                    <details className="w-full">
                      <summary className="cursor-pointer text-xs text-slate-400">详情</summary>
                      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs text-slate-600">
                        {log.detail}
                      </pre>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
