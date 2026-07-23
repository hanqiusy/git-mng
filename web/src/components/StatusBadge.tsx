import type { RepoStatus } from '../api';
import { Badge } from './ui';

/** §5 状态徽章：干净(绿) / 有改动(黄) / 领先远程(蓝) / 落后远程(紫) / 未知(灰) */
export default function StatusBadge({ status }: { status?: RepoStatus }) {
  if (!status || status.state === 'unknown') {
    return <Badge color="bg-slate-100 text-slate-500">状态未知</Badge>;
  }
  const badges: { color: string; text: string }[] = [];
  if ((status.dirty ?? 0) > 0) {
    badges.push({ color: 'bg-amber-100 text-amber-700', text: `${status.dirty} 处改动` });
  }
  if ((status.ahead ?? 0) > 0) {
    badges.push({ color: 'bg-blue-100 text-blue-700', text: `领先 ${status.ahead}` });
  }
  if ((status.behind ?? 0) > 0) {
    badges.push({ color: 'bg-purple-100 text-purple-700', text: `落后 ${status.behind}` });
  }
  if (badges.length === 0) {
    badges.push({ color: 'bg-emerald-100 text-emerald-700', text: '干净' });
  }
  return (
    <span className="inline-flex flex-wrap gap-1">
      {badges.map((b) => (
        <Badge key={b.text} color={b.color}>
          {b.text}
        </Badge>
      ))}
    </span>
  );
}
