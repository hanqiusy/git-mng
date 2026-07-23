import type { RepoItem } from '../api';
import { Badge, Btn } from './ui';

export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', { hour12: false });
}

interface RepoCardProps {
  repo: RepoItem;
  starred: boolean;
  starLoading?: boolean;
  onClone: () => void;
  onToggleStar: () => void;
}

/** F2.4 仓库条目：名称、可见性徽章、语言、star/fork、默认分支、更新时间、本地克隆标记 */
export default function RepoCard({ repo, starred, starLoading, onClone, onToggleStar }: RepoCardProps) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={repo.url}
              target="_blank"
              rel="noreferrer"
              className="truncate font-medium text-indigo-600 hover:underline"
            >
              {repo.fullName}
            </a>
            <Badge color={repo.private ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}>
              {repo.private ? '私有' : '公有'}
            </Badge>
            {repo.cloned && (
              <Badge color="bg-indigo-100 text-indigo-700">
                已克隆{repo.localPaths ? `（${repo.localPaths} 个路径）` : ''}
              </Badge>
            )}
          </div>
          {repo.description && (
            <p className="mt-1 line-clamp-2 text-sm text-slate-500">{repo.description}</p>
          )}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
            {repo.language && <span>语言：{repo.language}</span>}
            <span>★ {repo.stars}</span>
            <span>Fork {repo.forks}</span>
            <span>默认分支：{repo.defaultBranch}</span>
            <span>更新于 {formatTime(repo.updatedAt)}</span>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Btn
            onClick={onToggleStar}
            loading={starLoading}
            title={starred ? '取消 star' : 'Star 该仓库'}
          >
            {starred ? '★ 已 Star' : '☆ Star'}
          </Btn>
          <Btn variant="primary" onClick={onClone}>
            克隆
          </Btn>
        </div>
      </div>
    </div>
  );
}
