// PRODUCTION may view the experimental dashboard, limited to the Sales,
// Operations, Employees and Service tabs, and gains nothing else (owner
// 2026-09-25). The mechanism is DASHBOARD_TABS_BY_ROLE in role-policy.ts.
//
// Behavioural: the real Hono handlers against a stub DB. The stub answers the
// RBAC lookups from GRANTS below (a role's role_permissions rows) and returns
// no rows for every business query, so each assertion is about who may see
// which section, not about the figures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';

import prototype from '../src/api/routes/dashboard-prototype.ts';
import deliveryOrders from '../src/api/routes/delivery-orders.ts';
import serviceCases from '../src/api/routes/service-cases.ts';
import workers from '../src/api/routes/workers.ts';
import salesOrders from '../src/api/routes/sales-orders.ts';
import dashboardFinance from '../src/api/routes/dashboard-finance.ts';
import auth from '../src/api/routes/auth.ts';
import {
  dashboardTabsForRole, dashboardReadsForRole, withDashboardAccess, DASHBOARD_TAB_READS,
} from '../src/api/lib/role-policy.ts';

// role_permissions rows per table-defined role. PRODUCTION's real grants are
// UNMEASURED; these mirror what was observed on a PRODUCTION login (job cards
// and hours readable, 403 on /api/workers) plus two module grants the tab map
// must NOT turn into dashboard sections (purchase-orders) or finance access.
const GRANTS = {
  PRODUCTION: ['job-cards:read', 'working-hour-entries:read', 'purchase-orders:read'],
  FINANCE: ['dashboard:read', 'sales-orders:read', 'accounting:read'],
  WAREHOUSE: ['inventory:read'],
};

function makeDb() {
  return {
    prepare(sql) {
      let args = [];
      const rows = () => {
        // Gate lookup (rbac.ts loadRolePermissions): bound by role name.
        if (/JOIN roles r\s+ON r\.id\s+= rp\.roleId/.test(sql)) {
          return (GRANTS[args[0]] ?? []).map((p) => {
            const [resource, action] = p.split(':');
            return { resource, action };
          });
        }
        // /me/permissions role lookup: user id doubles as the role name.
        if (/u\.role AS "legacyRole"/.test(sql)) {
          return [{ roleId: `role_${args[0]}`, legacyRole: args[0], roleName: args[0] }];
        }
        // /me/permissions grant lookup: bound by role id.
        if (/WHERE rp\.roleId = \?/.test(sql)) {
          return (GRANTS[String(args[0]).replace(/^role_/, '')] ?? []).map((p) => {
            const [resource, action] = p.split(':');
            return { resource, action };
          });
        }
        return [];
      };
      const stmt = {
        bind: (...a) => { args = a; return stmt; },
        all: async () => ({ results: rows(), success: true }),
        first: async () => rows()[0] ?? null,
        run: async () => ({ success: true, meta: { changes: 0 } }),
        raw: async () => [],
      };
      return stmt;
    },
    batch: async (stmts) => stmts.map(() => ({ results: [], success: true })),
  };
}

function appFor(role) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('orgId', 'hookka');
    c.set('DB', makeDb());
    c.set('userRole', role);
    c.set('userId', role);
    await next();
  });
  app.route('/api/dashboard/prototype', prototype);
  app.route('/api/dashboard/finance', dashboardFinance);
  app.route('/api/delivery-orders', deliveryOrders);
  app.route('/api/service-cases', serviceCases);
  app.route('/api/workers', workers);
  app.route('/api/sales-orders', salesOrders);
  app.route('/api/auth', auth);
  return app;
}

async function get(role, path) {
  const res = await appFor(role).request(path, undefined, {});
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, body };
}

const denied = (availability) => /insufficient permission/.test(availability?.reason ?? '');

// ---- the tab map --------------------------------------------------------

test('PRODUCTION is limited to Sales, Operations, Employees and Service', () => {
  assert.deepEqual(dashboardTabsForRole('PRODUCTION'), ['sales', 'operations', 'people', 'service']);
  assert.deepEqual(dashboardTabsForRole(' production '), ['sales', 'operations', 'people', 'service']);
  for (const role of ['SUPER_ADMIN', 'ADMIN', 'OFFICE', 'SALES', 'FINANCE', '']) {
    assert.equal(dashboardTabsForRole(role), null, `${role} keeps every tab`);
    assert.equal(dashboardReadsForRole(role), null);
  }
});

test('the tabs read exactly their own feed sections, never finance or overview', () => {
  assert.deepEqual(
    [...dashboardReadsForRole('PRODUCTION')].sort(),
    ['inventory', 'production-orders', 'sales-orders', 'service-cases', 'workers'],
  );
  assert.equal(DASHBOARD_TAB_READS.finance, undefined);
  assert.equal(DASHBOARD_TAB_READS.overview, undefined);
});

test('dashboard viewers keep the experimental page; others do not gain it', () => {
  const has = (perms, role) => withDashboardAccess(perms, role).includes('dashboard-experimental:read');
  assert.ok(has(['dashboard:read'], 'FINANCE'));
  assert.ok(has(['dashboard:*'], 'OFFICE'));
  assert.ok(has(['*'], 'SUPER_ADMIN'));
  assert.ok(has(['*:read'], 'READ_ONLY'));
  assert.ok(has([], 'PRODUCTION'), 'the tab map opens the page');
  assert.ok(!has(['inventory:read'], 'WAREHOUSE'));
  assert.ok(!has(['sales-orders:*'], 'SALES'));
});

// ---- the feed -------------------------------------------------------------

test('PRODUCTION gets its four tabs\' sections from the feed and nothing else', async () => {
  const { status, body } = await get('PRODUCTION', '/api/dashboard/prototype');
  assert.equal(status, 200, 'the front door opens through the tab map, not sales-orders:read');
  assert.ok(body.sales, 'Sales tab');
  for (const k of ['production', 'lim', 'inventory', 'employee']) {
    assert.ok(!denied(body.availability[k]), `Operations / Employees need ${k}`);
  }
  assert.ok(!denied(body.availability.service), 'Service tab');
  // Not drawn on by any of its tabs, so withheld, even though PRODUCTION's own
  // grants include purchase-orders:read.
  assert.equal(body.delivery, null);
  assert.equal(body.purchase, null);
  assert.ok(denied(body.availability.delivery));
  assert.ok(denied(body.availability.purchase));
  // The feed carries no finance section at all.
  assert.equal(body.finance, undefined);
});

test('a role outside the map is gated on its own permissions, as before', async () => {
  // OFFICE: code role holding every non-finance module, so every section.
  const office = await get('OFFICE', '/api/dashboard/prototype');
  assert.equal(office.status, 200);
  for (const k of ['delivery', 'purchase', 'inventory', 'employee', 'production', 'lim']) {
    assert.ok(office.body[k] !== null, `OFFICE keeps ${k}`);
  }
  // WAREHOUSE holds no sales-orders:read, so the front door stays shut.
  assert.equal((await get('WAREHOUSE', '/api/dashboard/prototype')).status, 403);
  // FINANCE: sales-orders but no workers / inventory grant, so those are cut.
  const fin = await get('FINANCE', '/api/dashboard/prototype');
  assert.equal(fin.status, 200);
  assert.equal(fin.body.employee, null);
  assert.equal(fin.body.inventory, null);
});

// ---- the endpoints the four tabs call -------------------------------------

test('the Sales and Service tab side reads open for PRODUCTION', async () => {
  for (const path of [
    '/api/delivery-orders/pending-value',
    '/api/delivery-orders/stats',
    '/api/service-cases/approvals',
  ]) {
    const { status } = await get('PRODUCTION', path);
    assert.equal(status, 200, `${path} should open for the tab`);
  }
  // A role outside the map still needs the module permission.
  assert.equal((await get('WAREHOUSE', '/api/delivery-orders/stats')).status, 403);
  assert.equal((await get('WAREHOUSE', '/api/service-cases/approvals')).status, 403);
});

test('PRODUCTION gains no module access and no finance', async () => {
  for (const [path, perm] of [
    ['/api/workers', 'workers:read'],
    ['/api/sales-orders/delivery-progress', 'sales-orders:read'],
    ['/api/dashboard/finance?mode=monthly&month=2026-09', 'accounting:read'],
  ]) {
    const { status, body } = await get('PRODUCTION', path);
    assert.equal(status, 403, path);
    assert.equal(body.missingPermission, perm, path);
  }
  // Deciding a service approval stays on service-cases:approve.
  const res = await appFor('PRODUCTION').request(
    '/api/service-cases/sc1/approval/approve',
    { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } },
    {},
  );
  assert.equal(res.status, 403);
  assert.equal((await res.json()).missingPermission, 'service-cases:approve');
});

// ---- the menu and the route guard ------------------------------------------

test('/me/permissions opens the page to PRODUCTION and nothing more', async () => {
  const { status, body } = await get('PRODUCTION', '/api/auth/me/permissions');
  assert.equal(status, 200);
  assert.ok(body.permissions.includes('dashboard-experimental:read'));
  assert.ok(!body.permissions.some((p) => p.startsWith('dashboard:')));
  assert.deepEqual(body.dashboardTabs, ['sales', 'operations', 'people', 'service']);
  assert.ok(!body.navHidden.includes('/dashboard-experimental'));
  for (const p of ['/dashboard', '/daily-report', '/sales', '/service-cases', '/employees', '/accounting']) {
    assert.ok(body.navHidden.includes(p), `PRODUCTION must not see ${p}`);
  }
});

test('/me/permissions keeps existing viewers exactly as they were', async () => {
  const fin = await get('FINANCE', '/api/auth/me/permissions');
  assert.ok(fin.body.permissions.includes('dashboard-experimental:read'));
  assert.ok(!fin.body.navHidden.includes('/dashboard-experimental'));
  assert.equal(fin.body.dashboardTabs, null, 'every tab');

  const office = await get('OFFICE', '/api/auth/me/permissions');
  assert.ok(!office.body.navHidden.includes('/dashboard-experimental'));
  assert.equal(office.body.dashboardTabs, null);

  const wh = await get('WAREHOUSE', '/api/auth/me/permissions');
  assert.ok(!wh.body.permissions.includes('dashboard-experimental:read'));
  assert.ok(wh.body.navHidden.includes('/dashboard-experimental'));
});
