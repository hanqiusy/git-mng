import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { CloneRecord, ClonePath, GhUser } from '../api';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import { Badge, Btn, Empty, PageLoading } from '../components/ui';
import { useToast } from '../components/Toast';
import { formatTime } from '../components/RepoCard';

type ConfirmState =
  | { type: 'deleteLocal'; record: CloneRecord; entry: ClonePath }
  | { type: 'reclone'; record: CloneRecord; entry: ClonePath }
  | { type: 'deleteRemote'; record: CloneRecord }
  | null;

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

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const { items } = await api.listClones();
      setItems(items);
    } catch (err) {
      toast.error(err, '本地克隆列表加载失败');
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">
          共 {items.length} 个仓库、{items.reduce((n, c) => n + c.paths.length, 0)} 个本地路径
        </p>
        <Btn onClick={() => load()} loading={loading}>
          刷新状态
        </Btn>
      </div>

      {items.length === 0 ? (
        <Empty text="暂无本地克隆，去「我的仓库」或「全站搜索」克隆一个吧" />
      ) : (
        items.map((record) => (
          <div
            key={record.fullName}
            className="rounded-lg border border-slate-200 bg-white shadow-sm"
          >
            {/* 仓库级标题栏 */}
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2.5">
              <span className="font-medium text-slate-800">{record.fullName}</span>
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
                      <code className="break-all rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                        {entry.path}
                      </code>
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

      {/* 二次确认框 */}
      <ConfirmModal
        confirm={confirm}
        loading={confirmLoading}
        nameInput={deleteNameInput}
        onNameInput={setDeleteNameInput}
        onCancel={() => setConfirm(null)}
        onConfirm={doConfirm}
      />
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
