import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Capability } from '@fms/core';
import { api, refreshSession, setAccessToken, setSessionExpiredHandler } from './api';
import type { Me } from './types';

interface AuthState {
  user: Me | null;
  status: 'loading' | 'authenticated' | 'anonymous';
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
  can(cap: Capability): boolean;
  isSuperAdmin: boolean;
  /** True while a super admin works inside an organization other than their own. */
  isVisiting: boolean;
  /** Super admin: work inside another organization (null = back to the home organization). */
  switchOrg(orgId: string | null): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [user, setUser] = useState<Me | null>(null);
  const [status, setStatus] = useState<AuthState['status']>('loading');

  const loadMe = useCallback(async () => {
    const me = await api<Me>('/auth/me');
    setUser(me);
    setStatus('authenticated');
  }, []);

  useEffect(() => {
    setSessionExpiredHandler(() => {
      setAccessToken(null);
      setUser(null);
      setStatus('anonymous');
    });
    // Restore the session from the refresh cookie on first load.
    refreshSession()
      .then((ok) => (ok ? loadMe() : setStatus('anonymous')))
      .catch(() => setStatus('anonymous'));
  }, [loadMe]);

  const value = useMemo<AuthState>(() => {
    const isSuperAdmin = !!user?.isSuperAdmin;
    return {
      user,
      status,
      isSuperAdmin,
      isVisiting: !!user && user.orgId !== user.homeOrgId,
      async login(email, password) {
        const { accessToken } = await api<{ accessToken: string }>('/auth/login', { method: 'POST', body: { email, password } });
        setAccessToken(accessToken);
        await loadMe();
      },
      async logout() {
        await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
        setAccessToken(null);
        setUser(null);
        setStatus('anonymous');
        qc.clear();
      },
      can(cap) {
        return !!user && (isSuperAdmin || user.capabilities.includes('ADMIN') || user.capabilities.includes(cap));
      },
      async switchOrg(orgId) {
        const { accessToken } = await api<{ accessToken: string }>('/auth/switch-org', { method: 'POST', body: { orgId } });
        setAccessToken(accessToken);
        // Every cached query belongs to the previous organization.
        qc.clear();
        await loadMe();
      },
    };
  }, [user, status, loadMe, qc]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
