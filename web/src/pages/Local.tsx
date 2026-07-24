import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type {
  BranchInfo,
  CloneRecord,
  ClonePath,
  GhUser,
  GraphCommit,
  RepoStatus,
} from '../api';
import Modal from '../components/Modal';
import CreateLinkedRepoDialog from '../components/CreateLinkedRepoDialog';
import LinkFolderDialog from '../components/LinkFolderDialog';
import StatusBadge from '../components/StatusBadge';
import { Badge, Btn, Empty, PageLoading, Spinner } from '../components/ui';
import { useToast } from '../components/Toast';
import { formatTime } from '../components/RepoCard';
import { openExternal } from '../lib/openExternal';

type ConfirmState =
  | { type: 'deleteLocal'; record: CloneRecord; entry: ClonePath }
  | { type: 'reclone'; record: CloneRecord; entry: ClonePath }
  | { type: 'deleteRemote'; record: CloneRecord }
  | null;

type GraphTarget = { fullName: string; entry: ClonePath } | null;

/** F5 本地管理：按仓库分组列出本地路径，每路径独立 推送/拉取/打开/删除/一键重拉 */
export default function Local({ user }: { user: GhUser }) {
  const toast = useToast();
  const [items, setItems] = useState<CloneRecord[]>([]);
  const [loading, setLoading] = useState(true);
  /** 正在执行中的操作 key：`${path}:${action}` 或 `remote:${fullName}` */
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [deleteNameInput, setDeleteNameInput] = useState('');
  const [refreshingPaths, setRefreshingPaths] = useState<Set<string>>(new Set());
  const [graphTarget, setGraphTarget] = useState<GraphTarget>(null);
  const [showCreateLinked, setShowCreateLinked] = useState(false);
  const [showLinkFolder, setShowLinkFolder] = useState(false);

  const refreshRemoteStatuses = useCallback(
    async (records: CloneRecord[]) => {
      const paths = records.flatMap((record) => record.paths.map((entry) => entry.path));
      if (paths.length === 0) return;
      setRefreshingPaths((current) => new Set([...current, ...paths]));
      const results = await Promise.allSettled(
        paths.map(async (path) => {
          try {
            const { status } = await api.refreshCloneStatus(path);
            setItems((current) =>
              current.map((record) => ({
                ...record,
                paths: record.paths.map((entry) =>
                  entry.path === path ? { ...entry, status } : entry,
                ),
              })),
            );
          } finally {
            setRefreshingPaths((current) => {
              const next = new Set(current);
              next.delete(path);
              return next;
            });
          }
        }),
      );
      const failed = results.filter((result) => result.status === 'rejected').length;
      if (failed > 0) {
        toast.info(`${failed} 个本地路径无法刷新远端分支，已保留本地缓存状态`);
      }
    },
    // toast context methods are safe to retain; keeping this stable prevents background refresh loops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const { items } = await api.listClones();
      setItems(items);
      void refreshRemoteStatuses(items);
    } catch (err) {
      toast.error(err, '本地克隆列表加载失败');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshRemoteStatuses]);

  useEffect(() => {
    load();
  }, [load]);

  /** F5.3 每路径独立操作 */
  const runPathAction = async (
    entry: ClonePath,
    action: 'push' | 'pull' | 'open',
    label: string,
  ) => {
    setBusy(`${entry.path}:${action}`);
    try {
      if (action === 'push') await api.push(entry.path);
      else if (action === 'pull') await api.pull(entry.path);
      else await api.openDir(entry.path);
      toast.success(`${label}成功`);
      if (action !== 'open') await load(true);
    } catch (err) {
      toast.error(err, `${label}失败`);
    } finally {
      setBusy(null);
    }
  };

  const doConfirm = async () => {
    if (!confirm) return;
    setConfirmLoading(true);
    try {
      if (confirm.type === 'deleteLocal') {
        await api.deleteClone(confirm.entry.path);
        toast.success('已删除本地目录');
      } else if (confirm.type === 'reclone') {
        await api.reclone(confirm.entry.path);
        toast.success('已重新克隆');
      } else {
        await api.deleteRepo(confirm.record.owner, confirm.record.repo);
        toast.success(`已删除远程仓库 ${confirm.record.fullName}`);
      }
      setConfirm(null);
      setDeleteNameInput('');
      await load(true);
    } catch (err) {
      toast.error(
        err,
        confirm.type === 'deleteLocal'
          ? '删除本地目录失败'
          : confirm.type === 'reclone'
            ? '重新克隆失败'
            : '删除远程仓库失败',
      );
    } finally {
      setConfirmLoading(false);
    }
  };

  const isOwn = (record: CloneRecord) =>
    record.owner.toLowerCase() === user.login.toLowerCase();

  if (loading) return <PageLoading text="正在读取本地克隆状态…" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-500">
          共 {items.length} 个仓库、{items.reduce((n, c) => n + c.paths.length, 0)} 个本地路径
        </p>
        <div className="flex flex-wrap gap-2">
          <Btn variant="primary" onClick={() => setShowCreateLinked(true)}>
            新建本地 + GitHub 仓库
          </Btn>
          <Btn onClick={() => setShowLinkFolder(true)}>链接已有文件夹</Btn>
          <Btn onClick={() => load()} loading={loading}>
            刷新状态
          </Btn>
        </div>
      </div>

      {items.length === 0 ? (
        <Empty text="暂无本地仓库，可以新建、链接已有文件夹，或从 GitHub 克隆" />
      ) : (
        items.map((record) => (
          <div
            key={record.fullName}
            className="rounded-lg border border-slate-200 bg-white shadow-sm"
          >
            {/* 仓库级标题栏 */}
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2.5">
              <button
                type="button"
                className="font-medium text-indigo-600 hover:underline"
                title="在浏览器中打开仓库"
                onClick={() =>
                  void openExternal(
                    `https://github.com/${encodeURIComponent(record.owner)}/${encodeURIComponent(record.repo)}`,
                  )
                }
              >
                {record.fullName} ↗
              </button>
              <Badge
                color={
                  record.private
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-emerald-100 text-emerald-700'
                }
              >
                {record.private ? '私有' : '公有'}
              </Badge>
              <span className="text-xs text-slate-400">{record.paths.length} 个本地路径</span>
              {isOwn(record) && (
                <Btn
                  variant="danger"
                  className="ml-auto"
                  loading={busy === `remote:${record.fullName}`}
                  onClick={() => {
                    setDeleteNameInput('');
                    setConfirm({ type: 'deleteRemote', record });
                  }}
                >
                  删除远程仓库
                </Btn>
              )}
            </div>

            {/* 路径卡片列表 */}
            <div className="divide-y divide-slate-100">
              {record.paths.map((entry) => {
                const st = entry.status;
                return (
                  <div key={entry.path} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="max-w-full text-left"
                        title="点击打开本地目录"
                        onClick={() => runPathAction(entry, 'open', '打开目录')}
                      >
                        <code className="break-all rounded bg-indigo-50 px-2 py-0.5 text-xs text-indigo-700 hover:bg-indigo-100 hover:underline">
                          {entry.path} ↗
                        </code>
                      </button>
                      <StatusBadge status={st} />
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                      <span>
                        当前分支：{st?.branch ?? entry.ref ?? '未知'}
                        {entry.refType === 'tag' ? '（tag 克隆）' : ''}
                      </span>
                      <span>登记于 {formatTime(entry.addedAt)}</span>
                      {st?.lastCommit && (
                        <span className="max-w-full truncate">最后提交：{st.lastCommit}</span>
                      )}
                    </div>
                    <BranchOverview
                      status={st}
                      refreshing={refreshingPaths.has(entry.path)}
                      onOpenGraph={() => setGraphTarget({ fullName: record.fullName, entry })}
                    />
                    <div className="mt-2 flex flex-wrap gap-2">
                      {/* F3.2：非本人仓库推送置灰 */}
                      <Btn
                        variant="primary"
                        disabled={!isOwn(record)}
                        title={
                          isOwn(record) ? 'git push' : '非本人仓库，推送可能无权限'
                        }
                        loading={busy === `${entry.path}:push`}
                        onClick={() => runPathAction(entry, 'push', '推送')}
                      >
                        推送
                      </Btn>
                      <Btn
                        loading={busy === `${entry.path}:pull`}
                        onClick={() => runPathAction(entry, 'pull', '拉取')}
                      >
                        拉取
                      </Btn>
                      <Btn
                        loading={busy === `${entry.path}:open`}
                        onClick={() => runPathAction(entry, 'open', '打开目录')}
                      >
                        打开目录
                      </Btn>
                      <Btn
                        variant="danger"
                        onClick={() => setConfirm({ type: 'deleteLocal', record, entry })}
                      >
                        删除本地
                      </Btn>
                      <Btn
                        variant="danger"
                        onClick={() => setConfirm({ type: 'reclone', record, entry })}
                      >
                        一键删除重新拉取
                      </Btn>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))
      )}

      <CreateLinkedRepoDialog
        open={showCreateLinked}
        onClose={() => setShowCreateLinked(false)}
        onCreated={() => void load(true)}
      />
      <LinkFolderDialog
        open={showLinkFolder}
        defaultOwner={user.login}
        onClose={() => setShowLinkFolder(false)}
        onLinked={() => void load(true)}
      />

      {/* 二次确认框 */}
      <ConfirmModal
        confirm={confirm}
        loading={confirmLoading}
        nameInput={deleteNameInput}
        onNameInput={setDeleteNameInput}
        onCancel={() => setConfirm(null)}
        onConfirm={doConfirm}
      />
      <BranchGraphModal target={graphTarget} onClose={() => setGraphTarget(null)} />
    </div>
  );
}

function BranchOverview({
  status,
  refreshing,
  onOpenGraph,
}: {
  status?: RepoStatus;
  refreshing: boolean;
  onOpenGraph: () => void;
}) {
  const localBranches = status?.localBranches ?? [];
  const remoteBranches = status?.remoteBranches ?? [];

  return (
    <div className="mt-3 overflow-hidden rounded-md border border-slate-200 bg-slate-50">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2">
        <span className="text-xs font-semibold text-slate-700">分支状态</span>
        {refreshing ? (
          <span className="inline-flex items-center gap-1 text-xs text-indigo-600">
            <Spinner className="h-3 w-3" />
            正在同步远端…
          </span>
        ) : status?.remoteRefreshed ? (
          <span className="text-xs text-emerald-600">远端已同步</span>
        ) : (
          <span className="text-xs text-slate-400">远端缓存</span>
        )}
        <span className="ml-auto text-xs text-slate-400">
          本地 {localBranches.length} · 远端 {remoteBranches.length}
        </span>
      </div>

      {status?.remoteRefreshError && !refreshing && (
        <p
          className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-700"
          title={status.remoteRefreshError}
        >
          远端同步失败：{status.remoteRefreshError}
        </p>
      )}

      <div className="grid gap-px bg-slate-200 md:grid-cols-2">
        <BranchList
          title="本地分支"
          branches={localBranches}
          localBranches={localBranches}
          remoteBranches={remoteBranches}
        />
        <BranchList
          title="远端分支"
          branches={remoteBranches}
          localBranches={localBranches}
          remoteBranches={remoteBranches}
          remote
        />
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-white px-3 py-2">
        <span className="text-xs text-slate-500">聚焦比较本地与远端的最新提交节点</span>
        <Btn
          variant="ghost"
          disabled={localBranches.length === 0 && remoteBranches.length === 0}
          onClick={onOpenGraph}
        >
          展开分支树
        </Btn>
      </div>
    </div>
  );
}

function BranchGraphModal({ target, onClose }: { target: GraphTarget; onClose: () => void }) {
  const status = target?.entry.status;
  const local =
    status?.localBranches.find((branch) => branch.current) ?? status?.localBranches[0] ?? null;
  const remote =
    status?.remoteBranches.find((branch) => branch.name === local?.upstream) ??
    status?.remoteBranches[0] ??
    null;
  const relation = getPairRelation(local, remote);
  const commits = status?.graph ?? [];

  return (
    <Modal
      title={target ? `${target.fullName} · 图形分支树` : '图形分支树'}
      open={!!target}
      onClose={onClose}
      wide
      footer={<Btn onClick={onClose}>关闭</Btn>}
    >
      <div className="mb-3 space-y-1 text-xs text-slate-500">
        <span>路径：{target?.entry.path}</span>
        <p>仅展示当前本地分支与对应远端分支的最新节点，更早提交已省略。</p>
      </div>
      {!local && !remote ? (
        <div className="py-12 text-center text-sm text-slate-400">暂无可显示的分支节点</div>
      ) : (
        <CompressedBranchTree
          local={local}
          remote={remote}
          relation={relation}
          commits={commits}
        />
      )}
    </Modal>
  );
}

type BranchRelation =
  | 'local-newer'
  | 'remote-newer'
  | 'diverged'
  | 'synced'
  | 'local-only'
  | 'remote-only'
  | 'unknown';

const RELATION_STYLE: Record<
  BranchRelation,
  { label: string; dark: string; light: string }
> = {
  'local-newer': {
    label: '本地较新',
    dark: 'bg-cyan-500/20 text-cyan-200 ring-cyan-400/40',
    light: 'bg-cyan-100 text-cyan-700 ring-cyan-300',
  },
  'remote-newer': {
    label: '远端较新',
    dark: 'bg-violet-500/20 text-violet-200 ring-violet-400/40',
    light: 'bg-violet-100 text-violet-700 ring-violet-300',
  },
  diverged: {
    label: '本地远端已分叉',
    dark: 'bg-amber-500/20 text-amber-200 ring-amber-400/40',
    light: 'bg-amber-100 text-amber-700 ring-amber-300',
  },
  synced: {
    label: '本地远端已同步',
    dark: 'bg-emerald-500/20 text-emerald-200 ring-emerald-400/40',
    light: 'bg-emerald-100 text-emerald-700 ring-emerald-300',
  },
  'local-only': {
    label: '仅本地存在',
    dark: 'bg-cyan-500/20 text-cyan-200 ring-cyan-400/40',
    light: 'bg-cyan-100 text-cyan-700 ring-cyan-300',
  },
  'remote-only': {
    label: '仅远端存在',
    dark: 'bg-violet-500/20 text-violet-200 ring-violet-400/40',
    light: 'bg-violet-100 text-violet-700 ring-violet-300',
  },
  unknown: {
    label: '新旧关系未知',
    dark: 'bg-slate-500/20 text-slate-300 ring-slate-400/40',
    light: 'bg-slate-100 text-slate-600 ring-slate-300',
  },
};

function getLocalRelation(
  branch: BranchInfo | null,
  remoteBranches: BranchInfo[] = [],
): BranchRelation {
  if (!branch) return 'remote-only';
  if (!branch.upstream) return 'local-only';
  if (remoteBranches.length > 0 && !remoteBranches.some((remote) => remote.name === branch.upstream)) {
    return 'local-only';
  }
  const ahead = branch.ahead;
  const behind = branch.behind;
  if (ahead === null && behind === null) return 'unknown';
  if ((ahead ?? 0) > 0 && (behind ?? 0) > 0) return 'diverged';
  if ((ahead ?? 0) > 0) return 'local-newer';
  if ((behind ?? 0) > 0) return 'remote-newer';
  return 'synced';
}

function getRemoteRelation(branch: BranchInfo, localBranches: BranchInfo[]): BranchRelation {
  const local = localBranches.find((candidate) => candidate.upstream === branch.name);
  return local ? getLocalRelation(local, [branch]) : 'remote-only';
}

function getPairRelation(
  local: BranchInfo | null,
  remote: BranchInfo | null,
): BranchRelation {
  if (!local) return remote ? 'remote-only' : 'unknown';
  if (!remote) return 'local-only';
  if (local.commit === remote.commit) return 'synced';
  return getLocalRelation(local, [remote]);
}

function RelationBadge({
  relation,
  compact = false,
}: {
  relation: BranchRelation;
  compact?: boolean;
}) {
  const style = RELATION_STYLE[relation];
  return (
    <span
      className={`inline-flex items-center rounded-full ring-1 ${
        compact ? style.light : style.dark
      } ${
        compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-3 py-1 text-xs font-semibold'
      }`}
    >
      {style.label}
    </span>
  );
}

function CompressedBranchTree({
  local,
  remote,
  relation,
  commits,
}: {
  local: BranchInfo | null;
  remote: BranchInfo | null;
  relation: BranchRelation;
  commits: GraphCommit[];
}) {
  const localMiddle = Math.max((local?.ahead ?? 0) - 1, 0);
  const remoteMiddle = Math.max((local?.behind ?? 0) - 1, 0);
  const betweenTips = commitsBetween(commits, local?.commit, remote?.commit);
  const afterLocal = commitsAfter(commits, local?.commit);
  const afterRemote = commitsAfter(commits, remote?.commit);
  const hiddenDiverged = commits.filter(
    (commit) => commit.shortId !== local?.commit && commit.shortId !== remote?.commit,
  );

  return (
    <div className="overflow-hidden rounded-lg border border-slate-700 bg-slate-950 py-2">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2">
        <span className="text-xs text-slate-400">精简提交拓扑</span>
        <RelationBadge relation={relation} />
      </div>

      {relation === 'synced' && local && (
        <>
          <GraphCommitRow branch={local} side="synced" />
          <GraphEllipsisRow text="更早的共同提交已省略" commits={afterLocal} />
        </>
      )}

      {relation === 'local-newer' && (
        <>
          {local && <GraphCommitRow branch={local} side="local" />}
          {localMiddle > 0 && (
            <GraphEllipsisRow
              text={`省略 ${localMiddle} 个本地中间提交`}
              accent="local"
              commits={betweenTips}
            />
          )}
          {remote && <GraphCommitRow branch={remote} side="remote" />}
          <GraphEllipsisRow text="更早的共同提交已省略" commits={afterRemote} />
        </>
      )}

      {relation === 'remote-newer' && (
        <>
          {remote && <GraphCommitRow branch={remote} side="remote" />}
          {remoteMiddle > 0 && (
            <GraphEllipsisRow
              text={`省略 ${remoteMiddle} 个远端中间提交`}
              accent="remote"
              commits={betweenTips}
            />
          )}
          {local && <GraphCommitRow branch={local} side="local" />}
          <GraphEllipsisRow text="更早的共同提交已省略" commits={afterLocal} />
        </>
      )}

      {relation === 'diverged' && (
        <>
          {local && <GraphCommitRow branch={local} side="local" diverged="start" />}
          {remote && <GraphCommitRow branch={remote} side="remote" diverged="merge" />}
          <GraphEllipsisRow
            text="两侧中间提交与共同历史已省略"
            commits={hiddenDiverged}
          />
        </>
      )}

      {relation === 'local-only' && (
        <>
          {local && <GraphCommitRow branch={local} side="local" />}
          <GraphEllipsisRow text="本地更早提交已省略" accent="local" commits={afterLocal} />
        </>
      )}

      {relation === 'remote-only' && (
        <>
          {remote && <GraphCommitRow branch={remote} side="remote" />}
          <GraphEllipsisRow text="远端更早提交已省略" accent="remote" commits={afterRemote} />
        </>
      )}

      {relation === 'unknown' && (
        <>
          {local && <GraphCommitRow branch={local} side="local" />}
          {remote && <GraphCommitRow branch={remote} side="remote" />}
          <GraphEllipsisRow text="无法判断中间提交关系" commits={hiddenDiverged} />
        </>
      )}
    </div>
  );
}

function commitIndex(commits: GraphCommit[], shortId?: string) {
  if (!shortId) return -1;
  return commits.findIndex((commit) => commit.shortId === shortId);
}

function commitsBetween(
  commits: GraphCommit[],
  firstShortId?: string,
  secondShortId?: string,
) {
  const first = commitIndex(commits, firstShortId);
  const second = commitIndex(commits, secondShortId);
  if (first < 0 || second < 0) return [];
  const start = Math.min(first, second) + 1;
  const end = Math.max(first, second);
  return commits.slice(start, end);
}

function commitsAfter(commits: GraphCommit[], shortId?: string) {
  const index = commitIndex(commits, shortId);
  return index < 0 ? [] : commits.slice(index + 1);
}

function GraphCommitRow({
  branch,
  side,
  diverged,
}: {
  branch: BranchInfo;
  side: 'local' | 'remote' | 'synced';
  diverged?: 'start' | 'merge';
}) {
  const color = side === 'local' ? '#22d3ee' : side === 'remote' ? '#a78bfa' : '#34d399';
  const nodeGlow =
    side === 'synced'
      ? ''
      : side === 'local'
        ? 'drop-shadow-[0_0_5px_rgba(34,211,238,0.75)]'
        : 'drop-shadow-[0_0_5px_rgba(167,139,250,0.75)]';
  return (
    <div className="flex min-h-16 items-stretch border-b border-white/10">
      <svg width="76" height="64" className={`shrink-0 ${nodeGlow}`} aria-hidden="true">
        {diverged === 'start' ? (
          <>
            <line x1="30" y1="0" x2="30" y2="64" stroke="#22d3ee" strokeWidth="2.5" />
            <circle cx="30" cy="20" r="6" fill="#0f172a" stroke="#22d3ee" strokeWidth="3" />
          </>
        ) : diverged === 'merge' ? (
          <>
            <line x1="30" y1="0" x2="30" y2="64" stroke="#22d3ee" strokeWidth="2.5" />
            <path d="M 52 20 C 52 42, 30 42, 30 64" fill="none" stroke="#a78bfa" strokeWidth="2.5" />
            <circle cx="52" cy="20" r="6" fill="#0f172a" stroke="#a78bfa" strokeWidth="3" />
          </>
        ) : (
          <>
            <line x1="30" y1="0" x2="30" y2="64" stroke={color} strokeWidth="2.5" />
            <circle cx="30" cy="20" r="6" fill="#0f172a" stroke={color} strokeWidth="3" />
          </>
        )}
      </svg>
      <div className="min-w-0 flex-1 py-2 pr-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
          <span
            className={`rounded-full px-2 py-0.5 font-semibold ${
              side === 'local'
                ? 'bg-cyan-500/15 text-cyan-200'
                : side === 'remote'
                  ? 'bg-violet-500/15 text-violet-200'
                  : 'bg-emerald-500/15 text-emerald-200'
            }`}
          >
            {side === 'local' ? '本地最新' : side === 'remote' ? '远端最新' : '本地 = 远端'}
          </span>
          <code className="truncate text-slate-200">{branch.name}</code>
          <code className="text-slate-500">{branch.commit}</code>
        </div>
        <p className="mt-1 truncate text-xs text-slate-300" title={branch.subject}>
          {branch.subject || '无提交摘要'}
        </p>
      </div>
    </div>
  );
}

function GraphEllipsisRow({
  text,
  accent = 'neutral',
  commits = [],
}: {
  text: string;
  accent?: 'local' | 'remote' | 'neutral';
  commits?: GraphCommit[];
}) {
  const [expanded, setExpanded] = useState(false);
  const color = accent === 'local' ? '#22d3ee' : accent === 'remote' ? '#a78bfa' : '#64748b';
  return (
    <>
      <button
        type="button"
        className="flex h-14 w-full items-center border-b border-white/10 text-left transition-colors hover:bg-white/5 disabled:cursor-default disabled:hover:bg-transparent"
        disabled={commits.length === 0}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <svg width="76" height="56" className="shrink-0" aria-hidden="true">
          <line x1="30" y1="0" x2="30" y2="56" stroke={color} strokeWidth="2" strokeDasharray="3 4" />
          <circle cx="30" cy="22" r="2.3" fill={color} />
          <circle cx="30" cy="29" r="2.3" fill={color} />
          <circle cx="30" cy="36" r="2.3" fill={color} />
        </svg>
        <span className="min-w-0 flex-1 text-xs text-slate-500">{text}</span>
        {commits.length > 0 && (
          <span className="mr-4 text-xs text-indigo-300">
            {expanded ? '收起' : `展开 ${commits.length} 条`} {expanded ? '▴' : '▾'}
          </span>
        )}
      </button>
      {expanded &&
        commits.map((commit) => (
          <GraphHistoryRow key={commit.id} commit={commit} accent={accent} />
        ))}
    </>
  );
}

function GraphHistoryRow({
  commit,
  accent,
}: {
  commit: GraphCommit;
  accent: 'local' | 'remote' | 'neutral';
}) {
  const color = accent === 'local' ? '#22d3ee' : accent === 'remote' ? '#a78bfa' : '#64748b';
  return (
    <div className="flex min-h-14 items-stretch border-b border-white/10 bg-white/[0.025]">
      <svg width="76" height="56" className="shrink-0" aria-hidden="true">
        <line x1="30" y1="0" x2="30" y2="56" stroke={color} strokeWidth="2" />
        <circle cx="30" cy="20" r="4" fill="#0f172a" stroke={color} strokeWidth="2" />
      </svg>
      <div className="min-w-0 flex-1 py-2 pr-4">
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <code className="text-slate-300">{commit.shortId}</code>
          <span className="text-slate-600">{commit.date}</span>
          {commit.refs.map((ref) => (
            <span
              key={ref}
              className="rounded-full bg-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300"
            >
              {ref.replace(/^HEAD -> /, '')}
            </span>
          ))}
        </div>
        <p className="mt-1 truncate text-xs text-slate-400" title={commit.subject}>
          {commit.subject || '无提交摘要'}
        </p>
      </div>
    </div>
  );
}

function BranchList({
  title,
  branches,
  localBranches,
  remoteBranches,
  remote = false,
}: {
  title: string;
  branches: BranchInfo[];
  localBranches: BranchInfo[];
  remoteBranches: BranchInfo[];
  remote?: boolean;
}) {
  const panelStyle = remote
    ? 'border-violet-200 bg-violet-50/30'
    : 'border-cyan-200 bg-cyan-50/30';
  return (
    <div className={`min-w-0 border ${panelStyle} px-3 py-2`}>
      <p className={`mb-1.5 text-xs font-semibold ${remote ? 'text-violet-700' : 'text-cyan-700'}`}>
        {title}
      </p>
      {branches.length === 0 ? (
        <p className="py-2 text-xs text-slate-400">未发现分支</p>
      ) : (
        <div className="space-y-1.5">
          {branches.map((branch) => {
            const relation = remote
              ? getRemoteRelation(branch, localBranches)
              : getLocalRelation(branch, remoteBranches);
            const rowGlow =
              relation === 'synced'
                ? 'border-emerald-200 bg-white'
                : relation === 'local-newer'
                  ? remote
                    ? 'border-amber-200 bg-amber-50/70 shadow-[inset_0_0_8px_rgba(245,158,11,0.18)]'
                    : 'border-cyan-200 bg-cyan-50/70 shadow-[inset_0_0_8px_rgba(6,182,212,0.18)]'
                  : relation === 'remote-newer'
                    ? remote
                      ? 'border-violet-200 bg-violet-50/70 shadow-[inset_0_0_8px_rgba(139,92,246,0.18)]'
                      : 'border-amber-200 bg-amber-50/70 shadow-[inset_0_0_8px_rgba(245,158,11,0.18)]'
                    : relation === 'diverged'
                      ? remote
                        ? 'border-violet-200 bg-violet-50/70 shadow-[inset_0_0_8px_rgba(139,92,246,0.18)]'
                        : 'border-cyan-200 bg-cyan-50/70 shadow-[inset_0_0_8px_rgba(6,182,212,0.18)]'
                      : relation === 'local-only'
                        ? 'border-cyan-200 bg-cyan-50/70 shadow-[inset_0_0_8px_rgba(6,182,212,0.18)]'
                        : relation === 'remote-only'
                          ? 'border-violet-200 bg-violet-50/70 shadow-[inset_0_0_8px_rgba(139,92,246,0.18)]'
                          : 'border-slate-200 bg-slate-50';
            return (
            <div
              key={branch.name}
              className={`min-w-0 rounded border px-2 py-1.5 ${rowGlow}`}
            >
              <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    branch.current
                      ? 'bg-emerald-500'
                      : remote
                        ? 'bg-purple-400'
                        : 'bg-slate-300'
                  }`}
                />
                <code className="min-w-0 truncate font-semibold text-slate-700">
                  {branch.name}
                </code>
                {branch.current && (
                  <span className="rounded bg-emerald-100 px-1 text-[10px] text-emerald-700">
                    当前
                  </span>
                )}
                {(branch.ahead ?? 0) > 0 && (
                  <span className="rounded bg-blue-100 px-1 text-[10px] text-blue-700">
                    ↑{branch.ahead}
                  </span>
                )}
                {(branch.behind ?? 0) > 0 && (
                  <span className="rounded bg-purple-100 px-1 text-[10px] text-purple-700">
                    ↓{branch.behind}
                  </span>
                )}
                <RelationBadge relation={relation} compact />
              </div>
              <p className="mt-0.5 truncate text-[11px] text-slate-400" title={branch.subject}>
                {branch.commit} · {branch.subject || '无提交摘要'}
                {branch.upstream ? ` · → ${branch.upstream}` : ''}
              </p>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ConfirmModal({
  confirm,
  loading,
  nameInput,
  onNameInput,
  onCancel,
  onConfirm,
}: {
  confirm: ConfirmState;
  loading: boolean;
  nameInput: string;
  onNameInput: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!confirm) return null;

  let title = '';
  let body: React.ReactNode = null;
  let confirmText = '确认';
  let nameCheck: string | null = null;

  if (confirm.type === 'deleteLocal') {
    title = '删除本地目录';
    confirmText = '删除';
    body = (
      <p className="text-sm text-slate-600">
        将删除本地目录 <code className="break-all rounded bg-slate-100 px-1">{confirm.entry.path}</code>
        ，并移除映射记录。未推送的改动将永久丢失，远程仓库不受影响。
      </p>
    );
  } else if (confirm.type === 'reclone') {
    title = '一键删除重新拉取';
    confirmText = '删除并重新拉取';
    body = (
      <p className="text-sm text-slate-600">
        将删除 <code className="break-all rounded bg-slate-100 px-1">{confirm.entry.path}</code>
        ，然后按原{confirm.entry.refType === 'tag' ? '标签' : '分支'}{' '}
        <code className="rounded bg-slate-100 px-1">{confirm.entry.ref || '默认分支'}</code>
        重新克隆到同一路径。未推送的改动将永久丢失。
      </p>
    );
  } else {
    title = '删除远程仓库';
    confirmText = '永久删除远程仓库';
    nameCheck = confirm.record.repo;
    body = (
      <div className="space-y-3 text-sm text-slate-600">
        <p>
          将从 GitHub 永久删除仓库{' '}
          <span className="font-medium text-rose-600">{confirm.record.fullName}</span>
          ，此操作不可恢复（本地目录与克隆记录保留）。
        </p>
        <div>
          <label className="mb-1 block">
            请输入仓库名 <code className="rounded bg-slate-100 px-1">{confirm.record.repo}</code>{' '}
            以确认：
          </label>
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-rose-500 focus:outline-none"
            value={nameInput}
            onChange={(e) => onNameInput(e.target.value)}
            autoFocus
          />
        </div>
      </div>
    );
  }

  return (
    <Modal
      title={title}
      open
      onClose={onCancel}
      footer={
        <>
          <Btn onClick={onCancel}>取消</Btn>
          <Btn
            variant="danger"
            loading={loading}
            disabled={nameCheck !== null && nameInput.trim() !== nameCheck}
            onClick={onConfirm}
          >
            {confirmText}
          </Btn>
        </>
      }
    >
      {body}
    </Modal>
  );
}
