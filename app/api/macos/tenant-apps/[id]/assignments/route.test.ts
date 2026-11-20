import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { APP_ID, WIN_ID, G1, G2 } = vi.hoisted(() => ({
  APP_ID: '22222222-2222-2222-2222-222222222222',
  WIN_ID: '33333333-3333-3333-3333-333333333333',
  G1: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  G2: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
}));

const state = vi.hoisted(() => ({
  user: null as null | { userId: string; userEmail: string; tenantId: string },
  assignments: [] as Record<string, unknown>[],
  calls: [] as { method: string; args: unknown[] }[],
  failPatch: false,
}));

vi.mock('@/lib/auth-utils', () => ({ parseAccessToken: vi.fn(async () => state.user) }));
vi.mock('@/lib/db', () => ({ isSqliteMode: () => true }));
vi.mock('@/lib/supabase', () => ({ getServerClientOrNull: () => null }));
vi.mock('@/lib/intune/graph-client', () => ({ fetchWithRetry: vi.fn(), getServicePrincipalToken: vi.fn(async () => 'token') }));
vi.mock('@/lib/macos/jobs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/macos/jobs')>();
  const { GraphRequestError } = await import('@/lib/macos/graph');
  const apps: Record<string, Record<string, unknown>> = {
    [APP_ID]: { id: APP_ID, '@odata.type': '#microsoft.graph.macOSPkgApp', displayName: 'Visual Studio Code', primaryBundleId: 'com.microsoft.VSCode' },
    [WIN_ID]: { id: WIN_ID, '@odata.type': '#microsoft.graph.win32LobApp', displayName: 'Notepad++' },
  };
  return {
    ...actual,
    createGraphClientForTenant: () => ({
      getApp: async (id: string) => {
        if (!apps[id]) throw new GraphRequestError('not found', 404, null);
        return apps[id];
      },
      listAssignments: async () => state.assignments,
      getGroupName: async (id: string) => (id === G1 ? 'ArasDX_DevSecOps' : null),
      addAssignment: async (...args: unknown[]) => {
        state.calls.push({ method: 'add', args });
        const a = args[1] as { groupId: string; intent: string };
        state.assignments.push({ id: `${a.groupId}_0_0`, intent: a.intent, target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: a.groupId } });
      },
      updateAssignmentIntent: async (...args: unknown[]) => {
        if (state.failPatch) throw new GraphRequestError('Changing the assignment intent failed (HTTP 400): bad', 400, 'bad');
        state.calls.push({ method: 'patch', args });
      },
      deleteAssignment: async (...args: unknown[]) => state.calls.push({ method: 'delete', args }),
    }),
  };
});

import { GET, POST } from './route';
import { DELETE, PATCH } from './[assignmentId]/route';

const url = (id: string, rest = '') => `http://localhost/api/macos/tenant-apps/${id}/assignments${rest}`;
const req = (u: string, method = 'GET', body?: unknown) =>
  new NextRequest(u, {
    method,
    headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const actx = (id: string, assignmentId: string) => ({ params: Promise.resolve({ id, assignmentId }) });

beforeEach(() => {
  state.user = { userId: 'u1', userEmail: 'admin@example.test', tenantId: 't1' };
  state.calls = [];
  state.failPatch = false;
  state.assignments = [
    { id: `${G1}_1_0`, intent: 'required', target: { '@odata.type': '#microsoft.graph.groupAssignmentTarget', groupId: G1 } },
    { id: 'acacacac-9df4-4c7d-9d50-4ef0226f57a9_0_0', intent: 'available', target: { '@odata.type': '#microsoft.graph.allLicensedUsersAssignmentTarget', deviceAndAppManagementAssignmentFilterId: 'f1', deviceAndAppManagementAssignmentFilterType: 'include' } },
  ];
});

describe('macOS app assignments API', () => {
  it('requires a user', async () => {
    state.user = null;
    expect((await GET(req(url(APP_ID)), ctx(APP_ID))).status).toBe(401);
  });

  it('lists assignments with group names and target kinds', async () => {
    const response = await GET(req(url(APP_ID)), ctx(APP_ID));
    expect(response.status).toBe(200);
    const { assignments } = await response.json();
    expect(assignments).toEqual([
      { id: `${G1}_1_0`, intent: 'required', targetKind: 'group', groupId: G1, groupName: 'ArasDX_DevSecOps', hasFilter: false },
      expect.objectContaining({ targetKind: 'allUsers', intent: 'available', groupId: null, hasFilter: true }),
    ]);
  });

  it('refuses apps that are not macOS apps, unknown apps and malformed ids', async () => {
    expect((await GET(req(url(WIN_ID)), ctx(WIN_ID))).status).toBe(404);
    const unknown = '44444444-4444-4444-4444-444444444444';
    expect((await GET(req(url(unknown)), ctx(unknown))).status).toBe(404);
    expect((await GET(req(url('x')), ctx('../x'))).status).toBe(404);
    expect((await POST(req(url(WIN_ID), 'POST', { groupId: G2, groupName: 'X', intent: 'available' }), ctx(WIN_ID))).status).toBe(404);
  });

  it('adds a group and refuses a group that is already assigned', async () => {
    const ok = await POST(req(url(APP_ID), 'POST', { groupId: G2, groupName: 'Mac users', intent: 'available' }), ctx(APP_ID));
    expect(ok.status).toBe(201);
    expect(state.calls).toEqual([{ method: 'add', args: [APP_ID, { groupId: G2, groupName: 'Mac users', intent: 'available' }] }]);
    const dup = await POST(req(url(APP_ID), 'POST', { groupId: G1.toUpperCase(), groupName: 'ArasDX_DevSecOps', intent: 'available' }), ctx(APP_ID));
    expect(dup.status).toBe(409);
    const bad = await POST(req(url(APP_ID), 'POST', { groupId: G2, intent: 'install' }), ctx(APP_ID));
    expect(bad.status).toBe(400);
  });

  it('changes the intent of an existing assignment', async () => {
    const id = `${G1}_1_0`;
    const response = await PATCH(req(url(APP_ID, `/${id}`), 'PATCH', { intent: 'available' }), actx(APP_ID, id));
    expect(response.status).toBe(200);
    expect(state.calls).toEqual([{ method: 'patch', args: [APP_ID, id, 'available'] }]);
    expect((await PATCH(req(url(APP_ID, `/${id}`), 'PATCH', { intent: 'nope' }), actx(APP_ID, id))).status).toBe(400);
  });

  it('does not call Graph when the intent is unchanged, and reports Graph errors', async () => {
    const id = `${G1}_1_0`;
    expect((await PATCH(req(url(APP_ID, `/${id}`), 'PATCH', { intent: 'required' }), actx(APP_ID, id))).status).toBe(200);
    expect(state.calls).toEqual([]);
    state.failPatch = true;
    const failed = await PATCH(req(url(APP_ID, `/${id}`), 'PATCH', { intent: 'available' }), actx(APP_ID, id));
    expect(failed.status).toBe(502);
    expect((await failed.json()).error).toContain('HTTP 400');
  });

  it('removes only assignments that belong to the app', async () => {
    const id = `${G1}_1_0`;
    expect((await DELETE(req(url(APP_ID, `/${id}`), 'DELETE'), actx(APP_ID, id))).status).toBe(200);
    expect(state.calls).toEqual([{ method: 'delete', args: [APP_ID, id] }]);
    expect((await DELETE(req(url(APP_ID, '/other_0_0'), 'DELETE'), actx(APP_ID, 'other_0_0'))).status).toBe(404);
    expect((await DELETE(req(url(APP_ID, '/a%2Fb'), 'DELETE'), actx(APP_ID, 'a/b'))).status).toBe(404);
  });
});
