import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import {
  vpsConfigFromEnv, createTestRole, createTestDatabase, connectionUri,
  dropTestDatabase, dropTestRole, dropStaleTestObjects, TEST_PREFIX,
} from '@/lib/backup/vps-database'
import { splitMigrationStatements } from '@/lib/backup/migration-sql'
import type { DeliveryDiff } from '@/modules/google-shopping-for-shop/lib/delivery/diff'

// The delivery sync's own SQL, executed through the real functions: migration
// 021, the bookkeeping columns it adds, the jsonb the comparison and the
// managed-service list are stored as, and the change-log snapshot a push
// leaves behind.
//
// Typecheck, eslint and the build all see raw SQL as a plain string. Only a
// database can say it parses - and the jsonb casts here are exactly the shape
// that has broken before.
//
// SKIPS SILENTLY without OVH_SERVER / OVH_USER / OVH_PASSWORD in the shell,
// like lib/health-sql.test.ts. A skip is not a pass - export them from the
// Deskwell workspace's .env for the run. Provisions and drops its own
// throwaway database under TEST_PREFIX; it touches nothing else on the box.
const cfg = (() => { try { return vpsConfigFromEnv() } catch { return null } })()

// Every case here is several round trips to a Postgres on the other side of
// the country. Vitest's default five seconds is a local-database figure.
vi.setConfig({ testTimeout: 30_000 })

type StateModule = typeof import('@/modules/google-shopping-for-shop/lib/delivery/state')
type SettingsModule = typeof import('@/modules/google-shopping-for-shop/lib/settings')
type ChangeLogModule = typeof import('@/modules/google-shopping-for-shop/lib/change-log')

function diff(differences: number, comparedAt = '2026-09-22T09:00:00.000Z'): DeliveryDiff {
  return {
    comparedAt,
    differences,
    services: [
      {
        serviceName: 'Standard',
        status: differences > 0 ? 'different' : 'match',
        managed: true,
        differences: differences > 0
          ? [{ field: 'What it charges', here: 'Orion: 9.99', atGoogle: 'Orion: 7.99' }]
          : [],
      },
    ],
  }
}

describe.skipIf(!cfg)('google-shopping delivery SQL against a real database', () => {
  let db: PrismaClient
  let dbName: string
  let roleName: string
  let state: StateModule
  let settings: SettingsModule
  let changeLog: ChangeLogModule

  beforeAll(async () => {
    const suffix = `${Date.now()}`.slice(-9)
    dbName = `${TEST_PREFIX}gsd_${suffix}`
    roleName = `${TEST_PREFIX}role_gsd_${suffix}`
    await dropStaleTestObjects(cfg!)
    const role = await createTestRole(cfg!, roleName)
    await createTestDatabase(cfg!, dbName, role)
    const url = connectionUri(cfg!, dbName, role)
    db = new PrismaClient({ datasources: { db: { url } } })

    const initSql = path.join(process.cwd(), 'prisma/migrations/20260626000000_init/migration.sql')
    for (const statement of splitMigrationStatements(readFileSync(initSql, 'utf8'))) await db.$executeRawUnsafe(statement)
    for (const moduleName of ['shop', 'google-shopping-for-shop']) {
      const dir = path.join(process.cwd(), 'modules', moduleName, 'migrations')
      for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
        for (const statement of splitMigrationStatements(readFileSync(path.join(dir, file), 'utf8'))) await db.$executeRawUnsafe(statement)
      }
    }

    process.env.DATABASE_URL = url
    state = await import('@/modules/google-shopping-for-shop/lib/delivery/state')
    settings = await import('@/modules/google-shopping-for-shop/lib/settings')
    changeLog = await import('@/modules/google-shopping-for-shop/lib/change-log')
  }, 300_000)

  afterAll(async () => {
    const shared = await import('@/lib/db/prisma').catch(() => null)
    await shared?.prisma.$disconnect().catch(() => {})
    await db?.$disconnect().catch(() => {})
    if (dbName) await dropTestDatabase(cfg!, dbName).catch(() => {})
    if (roleName) await dropTestRole(cfg!, roleName).catch(() => {})
  }, 180_000)

  // ----- Migration 021 ---------------------------------------------------------

  it('021 adds every column with the defaults an existing install will get, and survives a second run', async () => {
    const sql = readFileSync(path.join(process.cwd(), 'modules/google-shopping-for-shop/migrations/021_delivery_sync.sql'), 'utf8')
    for (const statement of splitMigrationStatements(sql)) await db.$executeRawUnsafe(statement)

    const columns = await db.$queryRaw<Array<{ column_name: string; data_type: string; is_nullable: string }>>`
      SELECT "column_name", "data_type", "is_nullable" FROM information_schema.columns
      WHERE "table_name" = 'gsf_settings'
        AND "column_name" IN ('shipping_label_source', 'delivery_sync_enabled', 'delivery_managed_services',
                              'delivery_checked_at', 'delivery_differences', 'delivery_last_diff', 'delivery_pushed_at')
      ORDER BY "column_name"
    `
    expect(columns.map((row) => row.column_name)).toEqual([
      'delivery_checked_at', 'delivery_differences', 'delivery_last_diff', 'delivery_managed_services',
      'delivery_pushed_at', 'delivery_sync_enabled', 'shipping_label_source',
    ])
    expect(columns.find((row) => row.column_name === 'delivery_managed_services')?.data_type).toBe('jsonb')
    expect(columns.find((row) => row.column_name === 'delivery_last_diff')?.data_type).toBe('jsonb')

    // The defaults are what every existing install gets on its next update, so
    // they are the thing worth asserting: label source unchanged, check off.
    const [row] = await db.$queryRaw<Array<{ source: string; sync: boolean; managed: unknown }>>`
      SELECT "shipping_label_source" AS "source", "delivery_sync_enabled" AS "sync", "delivery_managed_services" AS "managed"
      FROM "gsf_settings" WHERE "id" = 'singleton'
    `
    expect(row?.source).toBe('attribute')
    expect(row?.sync).toBe(false)
    expect(row?.managed).toEqual([])
  })

  // ----- The settings the feed and the daily check read ------------------------

  it('reads and writes the label source and the daily check switch', async () => {
    const before = await settings.getGsfSettings()
    expect(before.shippingLabelSource).toBe('attribute')
    expect(before.deliverySyncEnabled).toBe(false)

    await settings.updateGsfSettings({ shippingLabelSource: 'delivery-services', deliverySyncEnabled: true })
    const after = await settings.getGsfSettings()
    expect(after.shippingLabelSource).toBe('delivery-services')
    expect(after.deliverySyncEnabled).toBe(true)

    await settings.updateGsfSettings({ shippingLabelSource: 'attribute', deliverySyncEnabled: false })
    expect((await settings.getGsfSettings()).shippingLabelSource).toBe('attribute')
  })

  // ----- The sync's own bookkeeping --------------------------------------------

  it('starts with nothing, and "never checked" is not the same as "they agree"', async () => {
    const empty = await state.readDeliveryState()
    expect(empty).toEqual({ managedServices: [], checkedAt: null, differences: null, lastDiff: null, pushedAt: null })
  })

  it('stores a whole comparison as jsonb and reads it back unchanged', async () => {
    const recorded = diff(1)
    await state.recordComparison(recorded)

    const held = await state.readDeliveryState()
    expect(held.differences).toBe(1)
    expect(held.checkedAt?.toISOString()).toBe('2026-09-22T09:00:00.000Z')
    expect(held.lastDiff).toEqual(recorded)
  })

  it('replaces the comparison rather than stacking them, zero included', async () => {
    await state.recordComparison(diff(0, '2026-09-23T09:00:00.000Z'))
    const held = await state.readDeliveryState()
    expect(held.differences).toBe(0)
    expect(held.lastDiff?.services[0]?.status).toBe('match')
    expect(held.checkedAt?.toISOString()).toBe('2026-09-23T09:00:00.000Z')
  })

  it('remembers which Merchant Center services are ours, deduplicated', async () => {
    const at = new Date('2026-09-23T10:15:00.000Z')
    await state.recordPush(['Standard', 'Express', 'Standard'], at)
    const held = await state.readDeliveryState()
    expect(held.managedServices).toEqual(['Standard', 'Express'])
    expect(held.pushedAt?.toISOString()).toBe(at.toISOString())
  })

  it('forgets a service that is no longer ours when the next push says so', async () => {
    await state.recordPush(['Standard'], new Date('2026-09-24T10:15:00.000Z'))
    expect((await state.readDeliveryState()).managedServices).toEqual(['Standard'])
  })

  // ----- The snapshot a push leaves behind --------------------------------------

  it('keeps a whole shipping-settings snapshot in the change log and hands it back', async () => {
    const before = {
      settings: {
        name: 'accounts/123/shippingSettings',
        etag: 'abc',
        services: [{ serviceName: 'Pallet delivery', minimumOrderValue: { amountMicros: '50000000', currencyCode: 'GBP' } }],
      },
      managedServices: [],
    }
    const after = {
      settings: {
        name: 'accounts/123/shippingSettings',
        etag: 'abc',
        services: [
          { serviceName: 'Pallet delivery', minimumOrderValue: { amountMicros: '50000000', currencyCode: 'GBP' } },
          { serviceName: 'Standard', rateGroups: [{ applicableShippingLabels: [], singleValue: { flatRate: { amountMicros: '9990000', currencyCode: 'GBP' } } }] },
        ],
      },
      managedServices: ['Standard'],
    }

    const id = await changeLog.recordChange({
      area: 'shipping',
      action: 'push',
      summary: 'Sent 1 delivery service to Merchant Center',
      before,
      after,
      createdBy: 'Tester',
    })
    expect(id).toBeTruthy()

    const [entry] = await changeLog.listChanges({ area: 'shipping', limit: 10 })
    expect(entry?.action).toBe('push')
    // The undo reads these straight back out of jsonb, so a nested structure
    // surviving the round trip byte for byte is the thing that matters.
    expect(entry?.before).toEqual(before)
    expect(entry?.after).toEqual(after)
  })

  // amendChange is new raw SQL, and a two-step push leans on it entirely: the
  // entry is written before the send and rewritten after it.
  it('amends an entry\'s outcome without disturbing what was there before', async () => {
    const before = { settings: { services: [{ serviceName: 'Pallet delivery' }] }, managedServices: [] }
    const intended = { settings: { services: [{ serviceName: 'Standard' }] }, managedServices: ['Standard'], status: 'pending' }

    const id = await changeLog.recordChange({
      area: 'shipping',
      action: 'push',
      summary: 'Sent 1 delivery service to Merchant Center (sending…)',
      before,
      after: intended,
      createdBy: 'Tester',
    })

    const pending = await changeLog.getChange(id)
    expect((pending?.after as { status?: string })?.status).toBe('pending')

    // What Google actually came back with - not our prediction of it.
    const confirmed = {
      settings: { services: [{ serviceName: 'Pallet delivery' }, { serviceName: 'Standard', active: true }] },
      managedServices: ['Standard'],
      status: 'done',
    }
    await changeLog.amendChange(id, { summary: 'Sent 1 delivery service to Merchant Center', after: confirmed })

    const done = await changeLog.getChange(id)
    expect(done?.summary).toBe('Sent 1 delivery service to Merchant Center')
    expect(done?.after).toEqual(confirmed)
    // The whole point of the snapshot: `before` is the thing being preserved
    // and nothing may rewrite it.
    expect(done?.before).toEqual(before)
    expect(done?.undoneAt).toBeNull()
  })

  it('records a refused send as failed rather than leaving it pending', async () => {
    const id = await changeLog.recordChange({
      area: 'shipping',
      action: 'push',
      summary: 'Sent 1 delivery service to Merchant Center (sending…)',
      before: { settings: { services: [] }, managedServices: [] },
      after: { settings: { services: [{ serviceName: 'Standard' }] }, managedServices: ['Standard'], status: 'pending' },
      createdBy: 'Tester',
    })
    await changeLog.amendChange(id, {
      summary: 'Sent 1 delivery service to Merchant Center - Google refused it, so nothing was changed',
      after: { settings: { services: [{ serviceName: 'Standard' }] }, managedServices: [], status: 'failed' },
    })
    const entry = await changeLog.getChange(id)
    expect((entry?.after as { status?: string })?.status).toBe('failed')
    expect(entry?.summary).toContain('refused')
  })

  // The pending -> done promotion, through the real log. This is what stops an
  // unreadable reply from leaving a push un-undoable for ever.
  it('settles an unconfirmed push once the live settings show it landed', async () => {
    const push = await import('@/modules/google-shopping-for-shop/lib/delivery/push')
    const intended = { serviceName: 'Standard', active: true, rateGroups: [{ applicableShippingLabels: [], singleValue: { noShipping: true } }] }

    const id = await changeLog.recordChange({
      area: 'shipping',
      action: 'push',
      summary: "Sent 1 delivery service to Merchant Center - sent, but Google's reply could not be read back",
      before: { settings: { services: [] }, managedServices: [] },
      after: { settings: { services: [intended] }, managedServices: ['Standard'], status: 'pending' },
      createdBy: 'Tester',
    })

    // What Merchant Center turns out to hold: our service exactly as intended,
    // beside somebody else's that we never touched.
    const live = { etag: 'zzz', services: [intended, { serviceName: 'Pallet delivery' }] }
    expect(await push.promoteUnconfirmedPush(live)).toBe(true)

    const settled = await changeLog.getChange(id)
    expect((settled?.after as { status?: string })?.status).toBe('done')
    expect(settled?.summary).toBe('Sent 1 delivery service to Merchant Center')
    // The LIVE settings, not our prediction - that is what Undo compares with.
    expect((settled?.after as { settings?: unknown })?.settings).toEqual(live)
    // And the ownership record is repaired, which a crash before the commit
    // would otherwise have left unwritten for ever.
    expect((await state.readDeliveryState()).managedServices).toEqual(['Standard'])
  })

  // The guard that stops it recording somebody else's change as ours.
  it('leaves an unconfirmed push alone when Merchant Center does not match', async () => {
    const push = await import('@/modules/google-shopping-for-shop/lib/delivery/push')
    const id = await changeLog.recordChange({
      area: 'shipping',
      action: 'push',
      summary: 'Sent 1 delivery service to Merchant Center (sending…)',
      before: { settings: { services: [] }, managedServices: [] },
      after: {
        settings: { services: [{ serviceName: 'Express', active: true }] },
        managedServices: ['Express'],
        status: 'sending',
      },
      createdBy: 'Tester',
    })
    // Google holds an Express, but not the one we meant to send.
    expect(await push.promoteUnconfirmedPush({ services: [{ serviceName: 'Express', active: false }] })).toBe(false)
    expect((await changeLog.getChange(id)?.then((entry) => (entry?.after as { status?: string })?.status))).toBe('sending')
  })

  it('leaves a settled push alone', async () => {
    const push = await import('@/modules/google-shopping-for-shop/lib/delivery/push')
    await changeLog.recordChange({
      area: 'shipping',
      action: 'push',
      summary: 'Sent 1 delivery service to Merchant Center',
      before: { settings: { services: [] }, managedServices: [] },
      after: { settings: { services: [] }, managedServices: ['Standard'], status: 'done' },
      createdBy: 'Tester',
    })
    expect(await push.promoteUnconfirmedPush({ services: [] })).toBe(false)
  })

  // Only the newest unsettled send can be settled by a Compare, so only its
  // Undo may point at one. Telling an older entry to go and compare would be
  // sending somebody off to press a button that cannot help them.
  it('tells an unsettled send to compare, and an older one that it is past settling', async () => {
    await import('@/modules/google-shopping-for-shop/lib/change-log-handlers')
    const pendingEntry = async (name: string) => changeLog.recordChange({
      area: 'shipping',
      action: 'push',
      summary: `Sent 1 delivery service to Merchant Center (${name})`,
      before: { settings: { services: [] }, managedServices: [] },
      after: { settings: { services: [{ serviceName: name }] }, managedServices: [name], status: 'pending' },
      createdBy: 'Tester',
    })

    const older = await pendingEntry('Older')
    // created_at is milliseconds, so the two entries must not share one.
    await new Promise((resolve) => setTimeout(resolve, 5))
    const newer = await pendingEntry('Newer')

    // The reason comes back on the OUTCOME. Nothing is restored on a skip, so
    // no log entry is written and there is nowhere else for it to go - which is
    // exactly how the careful wording used to vanish.
    const olderOutcome = await changeLog.undoChange(older, 'Tester')
    expect(olderOutcome.status).toBe('undone')
    if (olderOutcome.status === 'undone') {
      expect(olderOutcome.restored).toBe(0)
      expect(olderOutcome.message).toContain('A later send has happened since')
    }

    const newerOutcome = await changeLog.undoChange(newer, 'Tester')
    expect(newerOutcome.status).toBe('undone')
    if (newerOutcome.status === 'undone') {
      expect(newerOutcome.restored).toBe(0)
      expect(newerOutcome.message).toContain('Compare them and this settles itself')
    }

    // Neither was put back, so neither `before` snapshot was disturbed.
    expect((await changeLog.getChange(older))?.summary).toContain('(Older)')
    expect((await changeLog.getChange(newer))?.summary).toContain('(Newer)')
  })

  it('has "shipping" as a real change-log area with an undo behind it', async () => {
    await import('@/modules/google-shopping-for-shop/lib/change-log-handlers')
    expect(changeLog.isChangeLogArea('shipping')).toBe(true)
    expect(changeLog.canUndoArea('shipping')).toBe(true)
  })
})
