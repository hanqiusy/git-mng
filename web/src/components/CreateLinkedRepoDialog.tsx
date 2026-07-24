import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import Modal from './Modal';
import { Btn, Spinner } from './ui';
import { useToast } from './Toast';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
}

function joinPath(root: string, name: string) {
  const normalized = root.trim().replace(/[\\/]+$/, '');
  if (!normalized) return name;
  const separator = normalized.includes('\\') || /^[A-Za-z]:/.test(normalized) ? '\\' : '/';
  return `${normalized}${separator}${name}`;
}

export default function CreateLinkedRepoDialog({ open, onClose, onCreated }: Props) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(true);
  const [defaultRoot, setDefaultRoot] = useState('');
  const [rootLoading, setRootLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setDescription('');
    setIsPrivate(true);
    setRootLoading(true);
    api
      .getSettings()
      .then(({ settings }) => setDefaultRoot(settings.defaultCloneRoot))
      .catch((error) => toast.error(error, '读取默认目录失败'))
      .finally(() => setRootLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const targetPath = useMemo(() => joinPath(defaultRoot, name.trim() || '仓库名'), [defaultRoot, name]);

  const submit = async () => {
    if (!name.trim()) {
      toast.info('请填写仓库名');
      return;
    }
    setSubmitting(true);
    try {
      const { repo } = await api.createLinkedRepo(name.trim(), description.trim(), isPrivate);
      toast.success(`已创建并连接 ${repo.fullName}`);
      onCreated?.();
      onClose();
    } catch (error) {
      toast.error(error, '创建并连接失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="新建本地 + GitHub 仓库"
      open={open}
      onClose={onClose}
      footer={
        <>
          <Btn onClick={onClose}>取消</Btn>
          <Btn
            variant="primary"
            loading={submitting}
            disabled={rootLoading}
            onClick={() => void submit()}
          >
            创建并连接
          </Btn>
        </>
      }
    >
      <div className="space-y-4">
        <p className="rounded-md bg-indigo-50 px-3 py-2 text-sm text-indigo-700">
          将创建同名本地文件夹和 GitHub 空仓库，初始化 main 分支并自动连接 origin。
        </p>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">仓库名</label>
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如 my-project"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">描述（可选）</label>
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">仓库可见性</label>
          <select
            className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm"
            value={isPrivate ? 'private' : 'public'}
            onChange={(event) => setIsPrivate(event.target.value === 'private')}
          >
            <option value="private">私有（默认）</option>
            <option value="public">公有</option>
          </select>
        </div>
        <div>
          <div className="mb-1 flex items-center gap-2 text-sm font-medium text-slate-700">
            本地路径
            {rootLoading && <Spinner className="h-3.5 w-3.5 text-slate-400" />}
          </div>
          <code className="block break-all rounded-md bg-slate-100 px-3 py-2 text-xs text-slate-600">
            {targetPath}
          </code>
          <p className="mt-1 text-xs text-slate-400">路径来自设置中的默认克隆根目录。</p>
        </div>
      </div>
    </Modal>
  );
}
