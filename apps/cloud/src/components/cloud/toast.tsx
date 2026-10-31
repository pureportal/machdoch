"use client";

import { X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface Toast {
  id: number;
  message: string;
  tone: "info" | "error";
}
type ShowToast = (message: string, tone?: Toast["tone"]) => void;

const ToastContext = createContext<ShowToast>(() => undefined);
const visibleMs = { info: 3500, error: 8000 };

export function useToast(): ShowToast {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const dismiss = useCallback(
    (id: number) =>
      setToasts((current) => current.filter((toast) => toast.id !== id)),
    [],
  );
  const show = useCallback<ShowToast>(
    (message, tone = "info") => {
      const id = ++nextId.current;
      setToasts((current) => [...current.slice(-2), { id, message, tone }]);
      setTimeout(() => dismiss(id), visibleMs[tone]);
    },
    [dismiss],
  );
  const value = useMemo(() => show, [show]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="cloud-toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className="cloud-toast" data-tone={toast.tone}>
            <span>{toast.message}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(toast.id)}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
