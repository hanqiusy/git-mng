import { useState } from 'react';
import { api } from '../api';
import type { GhUser, RepoItem } from '../api';
import CloneDialog from '../components/CloneDialog';
import type { CloneTarget } from '../components/CloneDialog';
import RepoCard from '../components/RepoCard';
import { Btn, Empty, PageLoading } from '../components/ui';
import { useToast } from '../components/Toast';

const PAGE_SIZE = 30; // 与 server github.ts searchRepos 的 per_page 一致

/** F3 全站搜索：按 stars/forks/updated 排序 + 上一页/下一页分页 + 直接克隆 */
export default function Search({ user }: { user: GhUser }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('stars');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<RepoItem[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [cloneTarget, setCloneTarget] = useState<CloneTarget | null>(null);
  const [starred, setStarred] = useState<Set<string>>(new Set());
  const [starBusy, setStarBusy] = useState<string | null>(null);

  const doSearch = async (targetPage: number, kw = q, sortBy = sort) => {
    if (!kw.trim()) {
      toast.info('请输入搜索关键词');
      return;
    }
    setLoading(true);
    try {
      const res = await api.searchRepos(kw.trim(), sortBy, targetPage);
      setItems(res.items);
      setTotal(res.total);
      setPage(res.page);
      setSearched(true);
    } catch (err) {
      toast.error(err, '搜索失败');
    } finally {
      setLoading(false);
    }
  };

  const toggleStar = async (repo: RepoItem) => {
    const isStarred = starred.has(repo.fullName);
    setStarBusy(repo.fullName);
    try {
      if (isStarred) await api.unstar(repo.owner, repo.name);
      else await api.star(repo.owner, repo.name);
      setStarred((s) => {
        const next = new Set(s);
        if (isStarred) next.delete(repo.fullName);
        else next.add(repo.fullName);
        return next;
      });
      toast.success(isStarred ? `已取消 star ${repo.fullName}` : `已 star ${repo.fullName}`);
    } catch (err) {
      toast.error(err, 'star 操作失败');
    } finally {
      setStarBusy(null);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          doSearch(1);
        }}
      >
        <input
          className="w-80 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
          placeholder="搜索 GitHub 全站仓库，如 react state management"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value);
            if (searched) doSearch(1, q, e.target.value);
          }}
        >
          <option value="stars">按 star 数</option>
          <option value="forks">按 fork 数</option>
          <option value="updated">按最近更新</option>
        </select>
        <Btn variant="primary" type="submit" loading={loading}>
          搜索
        </Btn>
      </form>

      {loading ? (
        <PageLoading text="搜索中…" />
      ) : !searched ? (
        <Empty text="输入关键词开始搜索 GitHub 全站仓库" />
      ) : items.length === 0 ? (
        <Empty text="没有匹配的仓库" />
      ) : (
        <>
          <div className="text-sm text-slate-500">
            共 {total.toLocaleString()} 个结果（GitHub 最多返回前 1000 条）。
            克隆非本人仓库后，推送可能无权限。
          </div>
          <div className="space-y-2">
            {items.map((repo) => (
              <RepoCard
                key={repo.fullName}
                repo={repo}
                starred={starred.has(repo.fullName)}
                starLoading={starBusy === repo.fullName}
                onClone={() =>
                  setCloneTarget({
                    owner: repo.owner,
                    repo: repo.name,
                    defaultBranch: repo.defaultBranch,
                    private: repo.private,
                  })
                }
                onToggleStar={() => toggleStar(repo)}
              />
            ))}
          </div>
          <div className="flex items-center justify-center gap-3 pt-2">
            <Btn disabled={page <= 1} onClick={() => doSearch(page - 1)}>
              上一页
            </Btn>
            <span className="text-sm text-slate-500">
              第 {page} / {totalPages} 页
            </span>
            <Btn
              disabled={page >= totalPages || items.length < PAGE_SIZE}
              onClick={() => doSearch(page + 1)}
            >
              下一页
            </Btn>
          </div>
        </>
      )}

      <CloneDialog
        target={cloneTarget}
        onClose={() => setCloneTarget(null)}
        onCloned={() => {
          // F3.2：克隆他人仓库时提示推送可能无权限
          if (cloneTarget && cloneTarget.owner.toLowerCase() !== user.login.toLowerCase()) {
            toast.info('非本人仓库：推送可能无权限，仅建议本地使用');
          }
        }}
      />
    </div>
  );
}
