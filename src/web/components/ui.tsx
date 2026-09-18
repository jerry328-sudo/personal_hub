import { CheckCircle2, CircleAlert, LoaderCircle, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";

export function LoadingState({ label = "正在读取…" }: { label?: string }) {
  return <div className="loading-state" role="status"><LoaderCircle className="spin" aria-hidden="true" />{label}</div>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="state-message error-state" role="alert">
      <CircleAlert aria-hidden="true" />
      <strong>暂时无法显示</strong>
      <span>{message}</span>
      {onRetry ? <button className="btn" type="button" onClick={onRetry}>重新读取</button> : null}
    </div>
  );
}

export function EmptyState({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="state-message empty-state">
      <CheckCircle2 aria-hidden="true" />
      <strong>{title}</strong>
      {detail ? <span>{detail}</span> : null}
      {action}
    </div>
  );
}

interface DialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
  size?: "normal" | "wide";
}

export function Dialog({ open, title, children, onClose, size = "normal" }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  if (!open) return null;
  return (
    <dialog
      ref={ref}
      className={size === "wide" ? "dialog-wide" : undefined}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === ref.current) onClose(); }}
    >
      <div className="dialog-head">
        <h2>{title}</h2>
        <button className="icon-btn" type="button" onClick={onClose} aria-label="关闭弹窗"><X aria-hidden="true" /></button>
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  danger = false,
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void onConfirm();
  };
  return (
    <Dialog open={open} title={title} onClose={onClose}>
      <div className="dialog-description">{description}</div>
      <form className="dialog-actions" onSubmit={submit}>
        <button className="btn" type="button" onClick={onClose}>取消</button>
        <button className={`btn ${danger ? "danger" : "primary"}`} disabled={busy} type="submit">
          {busy ? "处理中…" : confirmLabel}
        </button>
      </form>
    </Dialog>
  );
}

interface ToastContextValue {
  showToast: (message: string, tone?: "success" | "error") => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; tone: "success" | "error"; id: number } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2700);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const showToast = useCallback((message: string, tone: "success" | "error" = "success") => {
    setToast({ message, tone, id: Date.now() });
  }, []);
  const value = useMemo(() => ({ showToast }), [showToast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className={`toast ${toast ? "show" : ""} ${toast?.tone === "error" ? "toast-error" : ""}`} aria-live="polite" role="status">
        {toast?.message ?? ""}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error("useToast 必须在 ToastProvider 中使用");
  return value;
}

export function AgentBadge({ name, index = 0, size = "normal" }: { name: string; index?: number; size?: "normal" | "large" }) {
  const letter = Array.from(name.trim())[0]?.toUpperCase() ?? "A";
  return <span className={`agent-badge badge-${Math.abs(index) % 4} ${size === "large" ? "large" : ""}`} aria-hidden="true">{letter}</span>;
}

export function StatusPill({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "muted" | "danger" | "warning" }) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}
