import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { GhUser, RepoItem } from '../api';
import CloneDialog from '../components/CloneDialog';
import type { CloneTarget } from '../components/CloneDialog';
import LinkFolderDialog from '../components/LinkFolderDialog';
import type { LinkTarget } from '../components/LinkFolderDialog';
import Modal from '../components/Modal';
import RepoCard from '../components/RepoCard';
import { Btn, Empty, PageLoading } from '../components/ui';
import { useToast } from '../components/Toast';

type Visibility = 'all' | 'public' | 'private';
type SortKey = 'updated' | 'name' | 'stars';

const VIS_TABS: { key: Visibility; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'public', label: '公有' },
  { key: 'private', label: '私有' },
];

/** F2 我的仓库：可见性筛选 + 前端即时搜索 + 排序 + 克隆/star/新建仓库 */
export default function MyRepos({ user }: { user: GhUser }) {
  const toast = useToast();
  const [items, setItems] = useState<RepoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [visibility, setVisibility] = useState<Visibility>('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('updated');
  const [cloneTarget, setCloneTarget] = useState<CloneTarget | null>(null);
  const [linkTarget, setLinkTarget] = useState<LinkTarget | null>(null);
  const [starred, setStarred] = useState<Set<string>>(new Set());
  const [starBusy, setStarBusy] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = async (vis: Visibility) => {
    setLoading(true);
    try {
      const { items } = await api.listRepos(vis);
      setItems(items);
    } catch (err) {
      toast.error(err, '仓库列表加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(visibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibility]);

  // F2.3 前端即时过滤（名称 + 描述）
  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    const list = kw
      ? items.filter(
          (r) =>
            r.name.toLowerCase().includes(kw) ||
            (r.description ?? '').toLowerCase().includes(kw),
        )
      : items;
    // F2.5 排序
    return [...list].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'stars') return b.stars - a.stars;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }, [items, q, sort]);

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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-md border border-slate-300 bg-white p-0.5">
          {VIS_TABS.map((t) => (
            <button
              key={t.key}
              className={`rounded px-3 py-1 text-sm ${
                visibility === t.key
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
              onClick={() => setVisibility(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <input
          className="w-64 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
          placeholder="搜索名称或描述…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
        >
          <option value="updated">最近更新优先</option>
          <option value="name">按名称</option>
          <option value="stars">按 star 数</option>
        </select>
        <div className="ml-auto flex gap-2">
          <Btn onClick={() => load(visibility)} loading={loading}>
            刷新
          </Btn>
          <Btn variant="primary" onClick={() => setShowCreate(true)}>
            新建仓库
          </Btn>
        </div>
      </div>

      {loading ? (
        <PageLoading text="正在加载仓库列表…" />
      ) : filtered.length === 0 ? (
        <Empty text={q ? '没有匹配的仓库' : '暂无仓库'} />
      ) : (
        <div className="space-y-2">
          {filtered.map((repo) => (
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
              onLink={() =>
                setLinkTarget({
                  owner: repo.owner,
                  repo: repo.name,
                  private: repo.private,
                })
              }
              onToggleStar={() => toggleStar(repo)}
            />
          ))}
        </div>
      )}

      <CloneDialog
        target={cloneTarget}
        onClose={() => setCloneTarget(null)}
        onCloned={() => load(visibility)}
      />
      <LinkFolderDialog
        open={!!linkTarget}
        target={linkTarget}
        defaultOwner={user.login}
        onClose={() => setLinkTarget(null)}
        onLinked={() => load(visibility)}
      />
      <CreateRepoModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={(repo) => {
          setShowCreate(false);
          load(visibility);
          // F5.6：创建成功后可立即克隆
          setCloneTarget({
            owner: user.login,
            repo: repo.name,
            defaultBranch: repo.defaultBranch,
            private: repo.private,
          });
        }}
      />
    </div>
  );
}

/** F5.6 新建仓库对话框 */
function CreateRepoModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (repo: RepoItem) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
      setIsPrivate(false);
    }
  }, [open]);

  const submit = async () => {
    if (!name.trim()) {
      toast.info('请填写仓库名');
      return;
    }
    setSubmitting(true);
    try {
      const { repo } = await api.createRepo(name.trim(), description.trim(), isPrivate);
      toast.success(`已创建仓库 ${repo.fullName}`);
      onCreated(repo);
    } catch (err) {
      toast.error(err, '创建仓库失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="新建仓库"
      open={open}
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>取消</Btn>
          <Btn variant="primary" loading={submitting} onClick={submit}>
            创建
          </Btn>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">仓库名</label>
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
            placeholder="my-new-repo"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">描述（可选）</label>
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={isPrivate}
            onChange={(e) => setIsPrivate(e.target.checked)}
          />
          私有仓库
        </label>
      </div>
    </Modal>
  );
}
