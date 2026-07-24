import { useEffect, useState } from 'react';
import { api } from './api';
import type { AccountInfo, GhUser } from './api';
import { ToastProvider, useToast } from './components/Toast';
import { PageLoading } from './components/ui';
import Login from './pages/Login';
import MyRepos from './pages/MyRepos';
import Search from './pages/Search';
import Local from './pages/Local';
import Settings from './pages/Settings';

type PageKey = 'my' | 'search' | 'local' | 'settings';

const NAV: { key: PageKey; label: string }[] = [
  { key: 'my', label: '我的仓库' },
  { key: 'search', label: '全站搜索' },
  { key: 'local', label: '本地管理' },
  { key: 'settings', label: '设置' },
];

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function Shell() {
  const toast = useToast();
  const [user, setUser] = useState<GhUser | null>(null);
  const [booting, setBooting] = useState(true);
  const [page, setPage] = useState<PageKey>('my');
  const [loggingOut, setLoggingOut] = useState(false);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const refreshAccounts = async () => {
    try {
      const s = await api.listAccounts();
      setAccounts(s.accounts);
      setActiveAccountId(s.activeAccountId);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    (async () => {
      try {
        const saved = await api.listAccounts();
        setAccounts(saved.accounts);
        setActiveAccountId(saved.activeAccountId);
        if (saved.autoLogin && saved.hasToken) {
          const { user } = await api.me();
          setUser(user);
          await refreshAccounts();
        } else {
          setUser(null);
        }
      } catch {
        setUser(null);
      } finally {
        setBooting(false);
      }
    })();
  }, []);

  const logout = async () => {
    setLoggingOut(true);
    setMenuOpen(false);
    try {
      await api.logout();
      setUser(null);
      setPage('my');
      toast.success('已退出登录（账号凭证仍保留）');
    } catch (err) {
      toast.error(err, '退出失败');
    } finally {
      setLoggingOut(false);
    }
  };

  const switchAccount = async (accountId: string) => {
    if (accountId === activeAccountId) {
      setMenuOpen(false);
      return;
    }
    setSwitching(true);
    try {
      const { user: next } = await api.switchAccount(accountId);
      setUser(next);
      setActiveAccountId(accountId);
      setPage('my');
      setMenuOpen(false);
      toast.success(`已切换到 ${next.login}`);
      await refreshAccounts();
    } catch (err) {
      toast.error(err, '切换账号失败');
    } finally {
      setSwitching(false);
    }
  };

  if (booting) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100">
        <PageLoading text="正在检查登录状态…" />
      </div>
    );
  }

  if (!user) {
    return (
      <Login
        onLogin={(u) => {
          setUser(u);
          void refreshAccounts();
        }}
      />
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-slate-100">
      <aside className="flex h-full w-40 shrink-0 flex-col overflow-hidden border-r border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-4 py-4">
          <h1 className="text-sm font-bold text-slate-800">GitHub 仓库管理</h1>
        </div>
        <nav className="flex-1 space-y-1 p-2">
          {NAV.map((item) => (
            <button
              key={item.key}
              className={`w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${
                page === item.key
                  ? 'bg-indigo-50 font-medium text-indigo-700'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
              onClick={() => setPage(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>

      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center justify-end gap-3 border-b border-slate-200 bg-white px-4 py-2.5">
          <div className="relative">
            <button
              type="button"
              className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-slate-100 disabled:opacity-60"
              onClick={() => setMenuOpen((v) => !v)}
              disabled={switching}
            >
              <img src={user.avatar_url} alt={user.login} className="h-7 w-7 rounded-full" />
              <span className="text-sm font-medium text-slate-700">
                {switching ? '切换中…' : (user.name ?? user.login)}
              </span>
              <span className="text-xs text-slate-400">▾</span>
            </button>
            {menuOpen && (
              <>
                <button
                  type="button"
                  className="fixed inset-0 z-20 cursor-default"
                  aria-label="关闭菜单"
                  onClick={() => setMenuOpen(false)}
                />
                <div className="absolute right-0 z-30 mt-1 w-56 rounded-lg border border-slate-200 bg-white py-1 shadow-lg">
                  <p className="px-3 py-1.5 text-xs text-slate-400">切换账号</p>
                  {accounts.map((acc) => (
                    <button
                      key={acc.id}
                      type="button"
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50 ${
                        acc.id === activeAccountId ? 'bg-indigo-50 text-indigo-700' : 'text-slate-700'
                      }`}
                      onClick={() => void switchAccount(acc.id)}
                    >
                      {acc.avatarUrl ? (
                        <img src={acc.avatarUrl} alt="" className="h-6 w-6 rounded-full" />
                      ) : (
                        <span className="h-6 w-6 rounded-full bg-slate-200" />
                      )}
                      <span className="min-w-0 flex-1 truncate">@{acc.login}</span>
                      {acc.id === activeAccountId && (
                        <span className="text-xs text-indigo-500">当前</span>
                      )}
                    </button>
                  ))}
                  <div className="my-1 border-t border-slate-100" />
                  <button
                    type="button"
                    className="w-full px-3 py-2 text-left text-sm text-slate-600 hover:bg-slate-50"
                    onClick={() => void logout()}
                    disabled={loggingOut}
                  >
                    {loggingOut ? '退出中…' : '退出登录'}
                  </button>
                </div>
              </>
            )}
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
          {page === 'my' && <MyRepos key={user.login} user={user} />}
          {page === 'search' && <Search key={user.login} user={user} />}
          {page === 'local' && <Local key={user.login} user={user} />}
          {page === 'settings' && (
            <Settings
              onCredentialsCleared={() => {
                setUser(null);
                setPage('my');
                setAccounts([]);
              }}
              onAccountsChanged={() => {
                void (async () => {
                  await refreshAccounts();
                  try {
                    const { user: u } = await api.me();
                    setUser(u);
                  } catch {
                    setUser(null);
                  }
                })();
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
}
