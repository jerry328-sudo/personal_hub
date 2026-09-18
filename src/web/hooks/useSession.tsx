import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { SessionDto } from "../../shared/contracts";
import { ApiError, sessionApi } from "../api";
import { passkeysApi } from "../passkeys";

interface SessionContextValue {
  session: SessionDto | null;
  loading: boolean;
  error: string | null;
  login: (secret: string) => Promise<void>;
  loginWithPasskey: () => Promise<void>;
  logout: () => Promise<void>;
  changeSecret: (currentSecret: string, newSecret: string) => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    sessionApi.get(controller.signal)
      .then((value) => setSession(value))
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        if (!(reason instanceof ApiError && reason.status === 401)) {
          setError(reason instanceof Error ? reason.message : "无法检查登录状态");
        }
        setSession(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    const onUnauthorized = () => setSession(null);
    window.addEventListener("personal-hub:unauthorized", onUnauthorized);
    return () => {
      controller.abort();
      window.removeEventListener("personal-hub:unauthorized", onUnauthorized);
    };
  }, []);

  const login = useCallback(async (secret: string) => {
    setError(null);
    const next = await sessionApi.login(secret);
    setSession(next);
  }, []);

  const logout = useCallback(async () => {
    try {
      await sessionApi.logout();
    } finally {
      setSession(null);
    }
  }, []);

  const loginWithPasskey = useCallback(async () => {
    setError(null);
    setSession(await passkeysApi.login());
  }, []);

  const changeSecret = useCallback(async (currentSecret: string, newSecret: string) => {
    await sessionApi.changeSecret(currentSecret, newSecret);
    setSession(null);
  }, []);

  const value = useMemo(() => ({ session, loading, error, login, loginWithPasskey, logout, changeSecret }), [session, loading, error, login, loginWithPasskey, logout, changeSecret]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession 必须在 SessionProvider 中使用");
  return value;
}
