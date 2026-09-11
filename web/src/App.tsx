import { createContext, useContext, useEffect, useState } from 'react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { getConfig } from './api';
import type { PublicConfig } from './types';
import { Icon, type IconName } from './components/Icon';
import { Button } from './components/ui/button';
import { cn } from '@/lib/utils';

interface ConfigValue {
  config: PublicConfig | null;
  reload: () => void;
}

const ConfigContext = createContext<ConfigValue>({ config: null, reload: () => {} });

export function useConfig(): PublicConfig | null {
  return useContext(ConfigContext).config;
}

export function useReloadConfig(): () => void {
  return useContext(ConfigContext).reload;
}

const NAV: Array<{ to: string; label: string; icon: IconName }> = [
  { to: '/', label: 'Dashboard', icon: 'grid' },
  { to: '/agents', label: 'Agents', icon: 'agents' },
  { to: '/runs', label: 'Runs', icon: 'runs' },
  { to: '/integrations', label: 'Integrations', icon: 'integrations' },
];

function Rail() {
  // Highlight the nav item whose route owns the current path (this also
  // covers /agents/new and /agents/:id under the Agents entry).
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <aside
      className={cn(
        'sticky top-0 z-20 flex items-center gap-3 overflow-x-auto border-b border-rule bg-card px-3.5 py-2.5',
        'md:flex-col md:items-stretch md:gap-7 md:overflow-y-auto md:border-b-0 md:border-r md:px-3.5 md:py-5',
      )}
    >
      <div className="flex shrink-0 items-center gap-2.5 px-1 md:px-2">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-primary text-[15px] font-bold text-primary-foreground"
          aria-hidden="true"
        >
          A
        </span>
        <div className="min-w-0">
          <div className="text-sm leading-4 font-semibold tracking-tight" translate="no">
            Agents OS
          </div>
          <div className="mt-0.5 hidden text-[11.5px] text-mute md:block">your autonomous team</div>
        </div>
      </div>

      <nav className="flex gap-1 md:flex-col md:gap-0.5" aria-label="Main">
        {NAV.map((item) => {
          const active =
            item.to === '/' ? pathname === '/' : pathname === item.to || pathname.startsWith(`${item.to}/`);
          return (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                'flex items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-[13.5px] font-medium whitespace-nowrap transition-colors duration-150',
                active
                  ? 'bg-primary font-semibold text-primary-foreground'
                  : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
              )}
              aria-current={active ? 'page' : undefined}
            >
              <Icon name={item.icon} size={16} />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

export function AppShell() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = async () => {
    try {
      setConfig(await getConfig());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void reload();
    const id = setInterval(() => void reload(), 30_000);
    return () => clearInterval(id);
  }, []);

  // A failed poll must not tear the console down: once config has loaded
  // once, transient errors keep the last known state and simply retry on the
  // next tick. The boot screen only appears when there is nothing to show.
  if (loadError && config === null) {
    return (
      <div className="mx-auto mt-[18vh] max-w-[540px] rounded-2xl border border-border bg-card p-8 shadow-float">
        <div className="mx-auto mb-3.5 flex size-11 items-center justify-center rounded-[13px] bg-surface-2 text-muted-foreground">
          <Icon name="alert" size={24} />
        </div>
        <h1 className="text-center text-2xl">Cannot reach the Agents OS server</h1>
        <p className="mt-2 text-center text-sm text-muted-foreground">{loadError}</p>
        <p className="mt-1 text-center text-xs text-mute">
          Start it with <code>pnpm dev</code>. The server listens on :8787 and the UI on :5173.
        </p>
        <div className="flex justify-center gap-2 pt-4">
          <Button onClick={() => void reload()}>
            <Icon name="refresh" size={14} /> Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <ConfigContext.Provider value={{ config, reload }}>
      <div className="min-h-dvh md:grid md:h-dvh md:grid-cols-[238px_minmax(0,1fr)] md:overflow-hidden">
        <a
          className="absolute top-0 left-0 z-[100] -translate-x-full rounded-br-[9px] bg-primary px-3.5 py-2 font-semibold text-primary-foreground focus:translate-x-0"
          href="#main"
        >
          Skip to content
        </a>
        <Rail />
        <main className="min-w-0 md:overflow-y-auto md:overflow-x-hidden" id="main">
          <Outlet />
        </main>
      </div>
    </ConfigContext.Provider>
  );
}

export default AppShell;
