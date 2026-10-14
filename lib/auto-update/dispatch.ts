/**
 * Shared auto-update → GitHub Actions dispatch mapping.
 *
 * buildAutoUpdateWorkflowInputs is the single mapping from a resolved
 * auto-update installer plus the saved deployment config to the
 * WorkflowInputs payload. The hosted manual update trigger
 * (app/api/updates/trigger) and the SQLite self-host auto-update path both
 * dispatch through it, so their GitHub Actions payloads stay identical.
 */

import { sanitizeAssignmentsForDispatch } from '@/lib/assignment-intents';
import { getAppConfig } from '@/lib/config';
import { buildIntuneAppDescription } from '@/lib/intune-description';
import { extractSilentSwitches } from '@/lib/msp/silent-switches';
import type { WorkflowInputs } from '@/lib/github-actions';
import type { DeploymentConfig } from '@/types/update-policies';

export interface AutoUpdateInstallerSource {
  wingetId?: string;
  displayName: string;
  latestVersion: string;
  installerUrl: string;
  installerSha256: string;
  installerType: string;
  nestedInstallerType?: string;
  nestedInstallerPath?: string;
  sourceType?: 'winget' | 'curated';
  curatedReleaseId?: string;
  currentIntuneAppId?: string | null;
}

/** The package callback URL workflow runs report progress back to. */
export function getAutoUpdateCallbackUrl(): string {
  const appConfig = getAppConfig();
  const baseUrl =
    appConfig.app.url ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');
  return `${baseUrl}/api/package/callback`;
}

export function buildAutoUpdateWorkflowInputs(args: {
  jobId: string;
  tenantId: string;
  wingetId: string;
  installer: AutoUpdateInstallerSource;
  deploymentConfig: DeploymentConfig;
  callbackUrl: string;
  carryOverAssignments: boolean;
  supersedePrevious: boolean;
  packageProfileSha256?: string;
}): WorkflowInputs {
  const { installer, deploymentConfig } = args;
  const installerType = installer.installerType || deploymentConfig.installerType || 'exe';

  return {
    sourceType: installer.sourceType,
    curatedReleaseId: installer.curatedReleaseId,
    jobId: args.jobId,
    tenantId: args.tenantId,
    wingetId: args.wingetId,
    displayName: deploymentConfig.displayName || installer.displayName,
    description: buildIntuneAppDescription({
      description: deploymentConfig.description,
      fallback: `Deployed via IntuneGet from Winget: ${args.wingetId}`,
    }),
    publisher: deploymentConfig.publisher || 'Unknown Publisher',
    version: installer.latestVersion,
    architecture: deploymentConfig.architecture || 'x64',
    installerUrl: installer.installerUrl,
    installerSha256: installer.installerSha256 || '',
    installerType,
    nestedInstallerType: installer.nestedInstallerType,
    nestedInstallerPath: installer.nestedInstallerPath,
    silentSwitches: extractSilentSwitches(
      deploymentConfig.installCommand || '',
      installerType,
      installer.nestedInstallerType
    ),
    uninstallCommand: deploymentConfig.uninstallCommand || '',
    callbackUrl: args.callbackUrl,
    detectionRules: deploymentConfig.detectionRules
      ? JSON.stringify(deploymentConfig.detectionRules)
      : undefined,
    // PSADT settings from the original deployment; the hosted trigger
    // backfills them onto the policy for pre-existing policies
    psadtConfig: deploymentConfig.psadtConfig
      ? JSON.stringify(deploymentConfig.psadtConfig)
      : undefined,
    assignments: deploymentConfig.assignments
      ? JSON.stringify(
          sanitizeAssignmentsForDispatch(
            deploymentConfig.assignments,
            Boolean(deploymentConfig.requirementRules?.length)
          )
        )
      : undefined,
    categories: deploymentConfig.categories
      ? JSON.stringify(deploymentConfig.categories)
      : undefined,
    requirementRules: deploymentConfig.requirementRules
      ? JSON.stringify(deploymentConfig.requirementRules)
      : undefined,
    relationships:
      deploymentConfig.relationships && deploymentConfig.relationships.length > 0
        ? JSON.stringify(deploymentConfig.relationships)
        : undefined,
    installScope: (deploymentConfig.installScope === 'user' ? 'user' : 'machine') as
      | 'machine'
      | 'user',
    forceCreate: deploymentConfig.forceCreateNewApp !== false,
    sourceIntuneAppId: installer.currentIntuneAppId || undefined,
    carryOverAssignments: args.carryOverAssignments,
    removeAssignmentsFromPreviousApp: args.carryOverAssignments,
    autoSupersede: args.supersedePrevious,
    supersedenceType: args.supersedePrevious ? 'update' : undefined,
    packageProfileSha256: args.packageProfileSha256,
  };
}
