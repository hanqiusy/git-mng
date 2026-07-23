import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { AccountInfo, GhUser, Settings } from '../api';
import { Btn } from '../components/ui';
import { useToast } from '../components/Toast';

interface LoginProps {
  onLogin: (user: GhUser) => void;
}

type Busy = null | 'oauth' | 'token' | `quick:${string}`;

type ProxyMode = Settings['proxyMode'];

const PROXY_OPTIONS: { key: ProxyMode; label: string }[] = [
  { key: 'system', label: '系统代理' },
  { key: 'custom', label: '自定义' },
  { key: 'none', label: '直连' },
];

async function openExternal(url: string) {
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

/** F1 登录页：多账号一键登录 + OAuth + 网络设置 */
export default function Login({ onLogin }: LoginProps) {
  const toast = useToast();
  const [busy, setBusy] = useState<Busy>(null);
  const [userCode, setUserCode] = useState('');
  const [verifyUrl, setVerifyUrl] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [token, setToken] = useState('');
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [autoLogin, setAutoLogin] = useState(false);
  const [showNet, setShowNet] = useState(false);
  const [net, setNet] = useState<Pick<Settings, 'proxyMode' | 'customProxy' | 'sslVerify'> | null>(
    null,
  );
  const [savingNet, setSavingNet] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopped = useRef(false);

  const refreshAccounts = async () => {
    try {
      const s = await api.listAccounts();
      setAccounts(s.accounts);
      setAutoLogin(s.autoLogin);
    } catch {
      setAccounts([]);
    }
  };

  useEffect(() => {
    stopped.current = false;
    void refreshAccounts();
    api
      .getSettings()
      .then(({ settings }) =>
        setNet({
          proxyMode: settings.proxyMode,
          customProxy: settings.customProxy,
          sslVerify: settings.sslVerify,
        }),
      )
      .catch(() => {
        /* 设置加载失败不阻塞登录 */
      });
    return () => {
      stopped.current = true;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  const clearPoll = () => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  };

  const toggleAutoLogin = async (checked: boolean) => {
    setAutoLogin(checked);
    try {
      await api.updateSettings({ autoLogin: checked });
    } catch (err) {
      setAutoLogin(!checked);
      toast.error(err, '无法保存自动登录设置');
    }
  };

  const saveNet = async () => {
    if (!net) return;
    setSavingNet(true);
    try {
      const { settings } = await api.updateSettings({
        proxyMode: net.proxyMode,
        customProxy: net.customProxy,
        sslVerify: net.sslVerify,
      });
      setNet({
        proxyMode: settings.proxyMode,
        customProxy: settings.customProxy,
        sslVerify: settings.sslVerify,
      });
      toast.success('网络设置已保存');
    } catch (err) {
      toast.error(err, '保存网络设置失败');
    } finally {
      setSavingNet(false);
    }
  };

  const quickLogin = async (accountId: string) => {
    setBusy(`quick:${accountId}`);
    try {
      const { user } = await api.quickLogin(accountId);
      toast.success(`欢迎回来，${user.login}`);
      onLogin(user);
    } catch (err) {
      toast.error(err, '快捷登录失败，请检查网络/代理或重新授权');
      await refreshAccounts();
    } finally {
      setBusy(null);
    }
  };

  const startOAuth = async () => {
    clearPoll();
    setBusy('oauth');
    setWaiting(false);
    setUserCode('');
    setVerifyUrl('');
    try {
      const started = await api.deviceStart();
      setUserCode(started.userCode);
      setVerifyUrl(started.verificationUriComplete || started.verificationUri);
      setWaiting(true);
      await openExternal(started.verificationUriComplete || started.verificationUri);

      const poll = async (sessionId: string, intervalSec: number) => {
        if (stopped.current) return;
        try {
          const result = await api.devicePoll(sessionId);
          if (result.status === 'ok') {
            setWaiting(false);
            toast.success(`欢迎，${result.user.login}`);
            onLogin(result.user);
            return;
          }
          const next = Math.max(5, result.interval || intervalSec);
          pollTimer.current = setTimeout(() => void poll(sessionId, next), next * 1000);
        } catch (err) {
          setWaiting(false);
          setUserCode('');
          toast.error(err, '授权失败');
        } finally {
          setBusy(null);
        }
      };

      pollTimer.current = setTimeout(
        () => void poll(started.sessionId, started.interval),
        started.interval * 1000,
      );
      setBusy(null);
    } catch (err) {
      toast.error(err, '无法启动 GitHub 登录');
      setWaiting(false);
      setBusy(null);
    }
  };

  const cancelWait = () => {
    clearPoll();
    setWaiting(false);
    setUserCode('');
    setVerifyUrl('');
    setBusy(null);
  };

  const submitToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) {
      toast.info('请输入 Personal Access Token');
      return;
    }
    setBusy('token');
    try {
      const { user } = await api.login(token.trim());
      setToken('');
      toast.success(`欢迎，${user.login}`);
      onLogin(user);
    } catch (err) {
      toast.error(err, '登录失败');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-8 shadow-lg">
        <h1 className="text-xl font-bold text-slate-800">GitHub 仓库管理工具</h1>
        <p className="mt-1 text-sm text-slate-500">使用 GitHub 账号授权登录</p>

        {accounts.length > 0 && !waiting && (
          <div className="mt-6 space-y-2">
            <p className="text-xs font-medium text-slate-500">已保存账号</p>
            {accounts.map((acc) => (
              <div
                key={acc.id}
                className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5"
              >
                {acc.avatarUrl ? (
                  <img src={acc.avatarUrl} alt={acc.login} className="h-9 w-9 rounded-full" />
                ) : (
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-200 text-xs text-slate-500">
                    ?
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">
                    {acc.name || acc.login}
                  </p>
                  <p className="truncate text-xs text-slate-500">@{acc.login}</p>
                </div>
                <Btn
                  variant="primary"
                  type="button"
                  loading={busy === `quick:${acc.id}`}
                  disabled={busy !== null && busy !== `quick:${acc.id}`}
                  onClick={() => void quickLogin(acc.id)}
                >
                  一键登录
                </Btn>
              </div>
            ))}
          </div>
        )}

        {!waiting ? (
          <div className={`space-y-3 ${accounts.length > 0 ? 'mt-4' : 'mt-6'}`}>
            <Btn
              variant={accounts.length > 0 ? 'secondary' : 'primary'}
              type="button"
              loading={busy === 'oauth'}
              disabled={busy !== null && busy !== 'oauth'}
              className="w-full py-2.5"
              onClick={() => void startOAuth()}
            >
              {busy === 'oauth'
                ? '正在打开 GitHub…'
                : accounts.length > 0
                  ? '使用其他 GitHub 账号授权'
                  : '使用 GitHub 登录'}
            </Btn>
            {accounts.length === 0 && (
              <p className="text-center text-xs text-slate-400">
                将打开浏览器完成授权；权限：repo、delete_repo、read:org
              </p>
            )}
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            <div className="rounded-lg border border-indigo-100 bg-indigo-50 p-4 text-center">
              <p className="text-sm text-slate-600">请在浏览器中确认授权，验证码：</p>
              <p className="mt-2 font-mono text-2xl font-bold tracking-widest text-indigo-700">
                {userCode}
              </p>
              <p className="mt-2 text-xs text-slate-500">等待 GitHub 确认中…</p>
            </div>
            {verifyUrl && (
              <a
                href={verifyUrl}
                target="_blank"
                rel="noreferrer"
                className="block text-center text-sm text-indigo-600 hover:underline"
              >
                浏览器未打开？点击这里
              </a>
            )}
            <Btn type="button" className="w-full" onClick={cancelWait}>
              取消
            </Btn>
          </div>
        )}

        <label className="mt-5 flex cursor-pointer items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={autoLogin}
            onChange={(e) => void toggleAutoLogin(e.target.checked)}
          />
          自动登录（启动时用最近账号直接进入）
        </label>

        <div className="mt-5 border-t border-slate-100 pt-4">
          <button
            type="button"
            className="text-xs text-slate-500 hover:text-slate-700"
            onClick={() => setShowNet((v) => !v)}
          >
            {showNet ? '收起网络设置' : '网络设置（代理 / SSL）'}
          </button>
          {showNet && net && (
            <div className="mt-3 space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs text-slate-500">
                若出现「无法连接 GitHub」，请先在此调整代理后再登录。
              </p>
              <div className="space-y-1.5">
                {PROXY_OPTIONS.map((opt) => (
                  <label key={opt.key} className="flex items-center gap-2 text-sm text-slate-700">
                    <input
                      type="radio"
                      name="loginProxy"
                      checked={net.proxyMode === opt.key}
                      onChange={() => setNet({ ...net, proxyMode: opt.key })}
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
              {net.proxyMode === 'custom' && (
                <input
                  className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
                  placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:7891"
                  value={net.customProxy}
                  onChange={(e) => setNet({ ...net, customProxy: e.target.value })}
                />
              )}
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={!net.sslVerify}
                  onChange={(e) => setNet({ ...net, sslVerify: !e.target.checked })}
                />
                跳过 SSL 校验（有风险）
              </label>
              <Btn variant="primary" loading={savingNet} onClick={() => void saveNet()}>
                保存网络设置
              </Btn>
            </div>
          )}
        </div>

        <div className="mt-4 border-t border-slate-100 pt-4">
          <button
            type="button"
            className="text-xs text-slate-400 hover:text-slate-600"
            onClick={() => setShowToken((v) => !v)}
          >
            {showToken ? '收起 Token 登录' : '高级：使用 Personal Access Token'}
          </button>
          {showToken && (
            <form onSubmit={submitToken} className="mt-3 space-y-3">
              <input
                type="password"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                placeholder="ghp_xxxxxxxxxxxxxxxx"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <Btn
                variant="primary"
                type="submit"
                loading={busy === 'token'}
                disabled={busy !== null && busy !== 'token'}
                className="w-full py-2"
              >
                Token 登录
              </Btn>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
