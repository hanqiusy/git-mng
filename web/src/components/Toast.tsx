import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError } from '../api';

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  text: string;
  /** 可展开的原始细节（如 git stderr，已脱敏） */
  detail?: string;
}

interface ToastCtx {
  success: (text: string) => void;
  info: (text: string) => void;
  error: (err: unknown, fallback?: string) => void;
}

const Ctx = createContext<ToastCtx | null>(null);

export function useToast(): ToastCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast 必须在 <ToastProvider> 内使用');
  return ctx;
}

const KIND_STYLE: Record<Toast['kind'], string> = {
  success: 'bg-emerald-600',
  error: 'bg-rose-600',
  info: 'bg-slate-700',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const push = useCallback((kind: Toast['kind'], text: string, detail?: string) => {
    const id = ++seq.current;
    setToasts((list) => [...list, { id, kind, text, detail }]);
    // 错误停留更久，便于展开查看细节
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), kind === 'error' ? 8000 : 3500);
  }, []);

  const ctx: ToastCtx = {
    success: (text) => push('success', text),
    info: (text) => push('info', text),
    error: (err, fallback = '操作失败') => {
      if (err instanceof ApiError) push('error', err.message, err.detail);
      else if (err instanceof Error) push('error', `${fallback}：${err.message}`);
      else push('error', fallback);
    },
  };

  return (
    <Ctx.Provider value={ctx}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex w-96 max-w-[90vw] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`rounded-lg px-4 py-3 text-sm text-white shadow-lg ${KIND_STYLE[t.kind]}`}
          >
            <div className="flex items-start justify-between gap-2">
              <span className="break-words">{t.text}</span>
              <button
                className="shrink-0 text-white/70 hover:text-white"
                onClick={() => setToasts((list) => list.filter((x) => x.id !== t.id))}
                aria-label="关闭"
              >
                ✕
              </button>
            </div>
            {t.detail && (
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-white/80">查看详情</summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-black/20 p-2 text-xs">
                  {t.detail}
                </pre>
              </details>
            )}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
