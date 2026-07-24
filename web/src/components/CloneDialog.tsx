import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { pickFolder } from '../lib/pickFolder';
import Modal from './Modal';
import { Btn, Spinner } from './ui';
import { useToast } from './Toast';

export interface CloneTarget {
  owner: string;
  repo: string;
  defaultBranch?: string;
  private?: boolean;
}

function buildDefaultClonePath(root: string, repo: string) {
  const normalizedRoot = root.trim().replace(/[\\/]+$/, '');
  if (!normalizedRoot) return repo;
  const separator =
    normalizedRoot.includes('\\') || /^[A-Za-z]:/.test(normalizedRoot) ? '\\' : '/';
  return `${normalizedRoot}${separator}${repo}`;
}

interface CloneDialogProps {
  target: CloneTarget | null;
  onClose: () => void;
  /** 克隆成功后回调（用于刷新列表/标记已克隆） */
  onCloned?: () => void;
}

/** F4.1 克隆对话框：目标路径 + 默认根目录生成 + 分支/标签下拉 + 浅克隆选项 */
export default function CloneDialog({ target, onClose, onCloned }: CloneDialogProps) {
  const toast = useToast();
  const defaultRoot = useRef<string | null>(null);
  const [path, setPath] = useState('');
  const [refType, setRefType] = useState<'branch' | 'tag'>('branch');
  const [ref, setRef] = useState('');
  const [shallow, setShallow] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [refsLoading, setRefsLoading] = useState(false);
  const [rootLoading, setRootLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // 页面加载后预取设置，用户点击“克隆”时通常可立即得到完整默认路径。
  useEffect(() => {
    api
      .getSettings()
      .then(({ settings }) => {
        defaultRoot.current = settings.defaultCloneRoot;
      })
      .catch(() => {
        /* 打开克隆弹窗时会重试并显示错误 */
      });
  }, []);

  // 打开时加载分支与标签
  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setPath(
      defaultRoot.current === null
        ? target.repo
        : buildDefaultClonePath(defaultRoot.current, target.repo),
    );
    setRefType('branch');
    setShallow(false);
    setRef(target.defaultBranch ?? '');
    setBranches([]);
    setTags([]);
    if (defaultRoot.current === null) {
      setRootLoading(true);
      api
        .getSettings()
        .then(({ settings }) => {
          defaultRoot.current = settings.defaultCloneRoot;
          if (!cancelled) setPath(buildDefaultClonePath(settings.defaultCloneRoot, target.repo));
        })
        .catch((err) => {
          if (!cancelled) toast.error(err, '读取默认克隆根目录失败');
        })
        .finally(() => {
          if (!cancelled) setRootLoading(false);
        });
    } else {
      setRootLoading(false);
    }
    setRefsLoading(true);
    Promise.allSettled([
      api.listBranches(target.owner, target.repo),
      api.listTags(target.owner, target.repo),
    ]).then(([b, t]) => {
      if (cancelled) return;
      if (b.status === 'fulfilled') {
        const names = b.value.items.map((x) => x.name);
        setBranches(names);
        setRef(
          names.length === 0
            ? ''
            : names.includes(target.defaultBranch ?? '')
              ? target.defaultBranch ?? ''
              : names[0],
        );
      } else {
        toast.error(b.reason, '分支列表加载失败');
      }
      if (t.status === 'fulfilled') setTags(t.value.items.map((x) => x.name));
      setRefsLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const refOptions = useMemo(() => (refType === 'branch' ? branches : tags), [refType, branches, tags]);

  const genDefaultPath = async () => {
    if (!target) return;
    setRootLoading(true);
    try {
      const { settings } = await api.getSettings();
      defaultRoot.current = settings.defaultCloneRoot;
      setPath(buildDefaultClonePath(settings.defaultCloneRoot, target.repo));
    } catch (err) {
      toast.error(err, '读取默认克隆根目录失败');
    } finally {
      setRootLoading(false);
    }
  };

  const cloneArgs = () => {
    if (!target) return null;
    return {
      owner: target.owner,
      repo: target.repo,
      path: path.trim(),
      ref,
      refType,
      shallow,
      private: target.private,
    };
  };

  const submit = async () => {
    if (!target) return;
    if (!path.trim()) {
      toast.info('请填写目标路径');
      return;
    }
    setSubmitting(true);
    try {
      await api.clone(cloneArgs()!);
      toast.success(`已克隆 ${target.owner}/${target.repo}`);
      onCloned?.();
      onClose();
    } catch (err) {
      toast.error(err, '克隆失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
      <Modal
        title={target ? `克隆 ${target.owner}/${target.repo}` : ''}
        open={!!target}
        onClose={onClose}
        footer={
          <>
            <Btn onClick={onClose}>取消</Btn>
            <Btn variant="primary" loading={submitting} disabled={rootLoading} onClick={submit}>
              {submitting ? '克隆中…' : '开始克隆'}
            </Btn>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">目标路径</label>
            <div className="flex flex-wrap gap-2">
              <input
                className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
                placeholder="例如 D:\github-clones\hello-world"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                disabled={rootLoading}
              />
              <Btn
                type="button"
                onClick={() => {
                  void (async () => {
                    const dir = await pickFolder(path);
                    if (dir) setPath(dir);
                  })();
                }}
              >
                选择文件夹
              </Btn>
              <Btn onClick={genDefaultPath} loading={rootLoading} title="使用默认根目录自动生成">
                默认根目录生成
              </Btn>
            </div>
          </div>

          <div className="flex gap-3">
            <div className="w-28">
              <label className="mb-1 block text-sm font-medium text-slate-700">类型</label>
              <select
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                value={refType}
                onChange={(e) => {
                  const t = e.target.value as 'branch' | 'tag';
                  setRefType(t);
                  const opts = t === 'branch' ? branches : tags;
                  setRef(t === 'branch' ? target?.defaultBranch ?? opts[0] ?? '' : opts[0] ?? '');
                }}
              >
                <option value="branch">分支</option>
                <option value="tag">标签</option>
              </select>
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-sm font-medium text-slate-700">
                {refType === 'branch' ? '分支' : '标签'}
                {refsLoading && <Spinner className="ml-2 inline h-3 w-3 text-slate-400" />}
              </label>
              <select
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                disabled={refsLoading}
              >
                {ref && !refOptions.includes(ref) && <option value={ref}>{ref}</option>}
                {refOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
                {!ref && refOptions.length === 0 && <option value="">（无可选项）</option>}
              </select>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={shallow}
              onChange={(e) => setShallow(e.target.checked)}
            />
            浅克隆（--depth 1，只拉取最新一次提交）
          </label>
        </div>
      </Modal>
  );
}
