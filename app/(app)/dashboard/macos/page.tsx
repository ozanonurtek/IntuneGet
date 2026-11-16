'use client';

import { useState } from 'react';
import { History, Laptop, Package, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/dashboard';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CatalogTab } from '@/components/macos/CatalogTab';
import { DeployDialog } from '@/components/macos/DeployDialog';
import { JobsTab } from '@/components/macos/JobsTab';
import { TenantAppsTab } from '@/components/macos/TenantAppsTab';
import { formatDateTime, readApiError } from '@/components/macos/format';
import { useMacosApi } from '@/components/macos/useMacosApi';
import type { MacosCatalogApp, MacosCatalogMeta } from '@/lib/macos/types';
import { cn } from '@/lib/utils';

export default function MacosAppsPage() {
  const api = useMacosApi();
  const [tab, setTab] = useState('catalog');
  const [meta, setMeta] = useState<MacosCatalogMeta | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [catalogReload, setCatalogReload] = useState(0);
  const [jobsReload, setJobsReload] = useState(0);
  const [deployApp, setDeployApp] = useState<MacosCatalogApp | null>(null);

  const refreshCatalog = async () => {
    setRefreshing(true);
    try {
      const response = await api('/api/macos/catalog/refresh', { method: 'POST' });
      if (!response.ok) throw new Error(await readApiError(response, 'Catalog refresh failed'));
      const body = (await response.json()) as { meta: MacosCatalogMeta };
      setMeta(body.meta);
      toast.success(`Catalog refreshed: ${body.meta.appCount} apps`);
      setCatalogReload((n) => n + 1);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Catalog refresh failed');
    } finally {
      setRefreshing(false);
    }
  };

  const onQueued = () => {
    setJobsReload((n) => n + 1);
    setTab('jobs');
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="macOS Apps"
        description={
          <>
            Deploy and update macOS PKG/DMG apps from the IntuneBrew catalog or your own custom apps.
            {meta && (
              <span className="block text-xs mt-1">
                {meta.appCount} apps, last refreshed {formatDateTime(meta.lastRefreshedAt)}
                {meta.refreshing ? ' (refreshing...)' : ''}
                {meta.lastError ? ` - ${meta.lastError}` : ''}
              </span>
            )}
          </>
        }
        gradient
        gradientColors="cyan"
        actions={
          <Button
            variant="ghost"
            onClick={() => void refreshCatalog()}
            disabled={refreshing}
            className="text-text-secondary hover:text-text-primary"
          >
            <RefreshCw className={cn('w-4 h-4 mr-2', refreshing && 'animate-spin')} />
            Refresh catalog
          </Button>
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="glass-light border border-overlay/5">
          <TabsTrigger value="catalog" className="data-[state=active]:bg-overlay/10">
            <Package className="w-4 h-4 mr-2" />
            Catalog
          </TabsTrigger>
          <TabsTrigger value="tenant" className="data-[state=active]:bg-overlay/10">
            <Laptop className="w-4 h-4 mr-2" />
            Our Macs&apos; apps
          </TabsTrigger>
          <TabsTrigger value="jobs" className="data-[state=active]:bg-overlay/10">
            <History className="w-4 h-4 mr-2" />
            Jobs
          </TabsTrigger>
        </TabsList>
        <TabsContent value="catalog" className="mt-6">
          <CatalogTab reloadKey={catalogReload} onMeta={setMeta} onDeploy={setDeployApp} />
        </TabsContent>
        <TabsContent value="tenant" className="mt-6">
          <TenantAppsTab onQueued={onQueued} />
        </TabsContent>
        <TabsContent value="jobs" className="mt-6">
          <JobsTab reloadKey={jobsReload} />
        </TabsContent>
      </Tabs>

      <DeployDialog app={deployApp} onOpenChange={(open) => !open && setDeployApp(null)} onQueued={onQueued} />
    </div>
  );
}
