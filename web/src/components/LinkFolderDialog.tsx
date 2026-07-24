import { useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import { pickFolder } from '../lib/pickFolder';
import Modal from './Modal';
import { Btn } from './ui';
import { useToast } from './Toast';

export interface LinkTarget {
  owner: string;
  repo: string;
  private?: boolean;
}

interface Props {
  open: boolean;
  target?: LinkTarget | null;
  defaultOwner: string;
  onClose: () => void;
  onLinked?: () => void;
}

/** 只连接已有文件夹；不会克隆、移动或覆盖文件。 */
export default function LinkFolderDialog({
  open,
  target,
  defaultOwner,
  onClose,
  onLinked,
}: Props) {
  const toast = useToast();
  const [owner, setOwner] = useState(defaultOwner);
  const [repo, setRepo] = useState('');
  const [path, setPath] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [confirmInitialize, setConfirmInitialize] = useState(false);

  useEffect(() => {
    if (!open) return;
    setOwner(target?.owner ?? defaultOwner);
    setRepo(target?.repo ?? '');
    setPath('');
    setConfirmInitialize(false);
  }, [defaultOwner, open, target]);

  const link = async (initialize: boolean) => {
    if (!owner.trim() || !repo.trim()) {
      toast.info('请填写 GitHub 仓库');
      return;
    }
    if (!path.trim()) {
      toast.info('请选择已有文件夹');
      return;
    }
    setSubmitting(true);
    try {
      await api.linkLocalFolder({
        owner: owner.trim(),
        repo: repo.trim(),
        path: path.trim(),
        initialize,
      });
      toast.success(`已连接 ${owner.trim()}/${repo.trim()}`);
      setConfirmInitialize(false);
      onLinked?.();
      onClose();
    } catch (error) {
      if (!initialize && error instanceof ApiError && error.code === 'LINK_NOT_GIT') {
        setConfirmInitialize(true);
      } else {
        toast.error(error, initialize ? '初始化并连接失败' : '连接文件夹失败');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Modal
        title="链接本地文件夹"
        open={open && !confirmInitialize}
        onClose={onClose}
        footer={
          <>
            <Btn onClick={onClose}>取消</Btn>
            <Btn variant="primary" loading={submitting} onClick={() => void link(false)}>
              完成连接
            </Btn>
          </>
        }
      >
        <div className="space-y-4">
          <p className="rounded-md bg-indigo-50 px-3 py-2 text-sm text-indigo-700">
            只连接已有文件夹，不会下载、移动或覆盖其中的文件。
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">GitHub 用户</label>
              <input
                className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                value={owner}
                disabled={!!target}
                onChange={(event) => setOwner(event.target.value)}
                placeholder="owner"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">仓库名</label>
              <input
                className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                value={repo}
                disabled={!!target}
                onChange={(event) => setRepo(event.target.value)}
                placeholder="repository"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">已有文件夹</label>
            <div className="flex gap-2">
              <input
                className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
                value={path}
                onChange={(event) => setPath(event.target.value)}
                placeholder="选择本机已有文件夹"
              />
              <Btn
                type="button"
                onClick={() =>
                  void pickFolder(path).then((selected) => selected && setPath(selected))
                }
              >
                选择文件夹
              </Btn>
            </div>
          </div>
        </div>
      </Modal>

      <Modal
        title="需要初始化 Git"
        open={open && confirmInitialize}
        onClose={() => !submitting && setConfirmInitialize(false)}
        footer={
          <>
            <Btn onClick={() => setConfirmInitialize(false)} disabled={submitting}>
              返回
            </Btn>
            <Btn variant="primary" loading={submitting} onClick={() => void link(true)}>
              初始化并连接
            </Btn>
          </>
        }
      >
        <p className="text-sm text-slate-700">
          该文件夹还不是 Git 仓库。是否在其中执行 Git 初始化，并将 origin 连接到{' '}
          <span className="font-medium">
            {owner.trim()}/{repo.trim()}
          </span>
          ？
        </p>
        <p className="mt-2 text-sm text-slate-500">
          现有文件会原样保留；只会新增 .git 元数据和远端配置。
        </p>
      </Modal>
    </>
  );
}
