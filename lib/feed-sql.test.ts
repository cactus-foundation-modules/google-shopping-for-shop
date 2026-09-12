import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import {
  vpsConfigFromEnv, createTestRole, createTestDatabase, connectionUri,
  dropTestDatabase, dropTestRole, dropStaleTestObjects, TEST_PREFIX,
} from '@/lib/backup/vps-database'
import { splitMigrationStatements } from '@/lib/backup/migration-sql'

// This module's own SQL, executed. Nothing else in the repo runs it: typecheck,
// eslint and the build all treat a query as a string, so a statement Postgres
// will not parse stays green everywhere until a live site hits it.
//
// Covers migration 012 and both statements in lib/withheld.ts - the jsonb write
// the feed route makes on every fetch, and the read the settings tab makes on
// every render. The write in particular carries a `::jsonb` cast around a
// parameter, which is exactly the shape that has bitten this codebase before.
//
// SKIPS SILENTLY without OVH_SERVER / OVH_USER / OVH_PASSWORD in the shell, the
// same way lib/backup/shop-sql.test.ts does. A skip is not a pass - export them
// from the Deskwell workspace's .env for the run. Provisions and drops its own
// throwaway database under TEST_PREFIX; it touches nothing else on the box.
const cfg = (() => { try { return vpsConfigFromEnv() } catch { return null } })()

describe.skipIf(!cfg)('google-shopping SQL against a real database', () => {
  let db: PrismaClient
  let dbName: string
  let roleName: string

  beforeAll(async () => {
    const suffix = `${Date.now()}`.slice(-9)
    dbName = `${TEST_PREFIX}gsf_${suffix}`
    roleName = `${TEST_PREFIX}role_gsf_${suffix}`
    await dropStaleTestObjects(cfg!)
    const role = await createTestRole(cfg!, roleName)
    await createTestDatabase(cfg!, dbName, role)
    db = new PrismaClient({ datasources: { db: { url: connectionUri(cfg!, dbName, role) } } })

    // Core first, then shop, then this module: gsf's own migrations carry
    // foreign keys onto shp_products, and shop's reference core's tables. The
    // same stack an install builds, in the same order.
    const initSql = path.join(process.cwd(), 'prisma/migrations/20260626000000_init/migration.sql')
    for (const s of splitMigrationStatements(readFileSync(initSql, 'utf8'))) {
      await db.$executeRawUnsafe(s)
    }
    for (const moduleName of ['shop', 'google-shopping-for-shop']) {
      const dir = path.join(process.cwd(), 'modules', moduleName, 'migrations')
      expect(existsSync(dir)).toBe(true)
      for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
        for (const s of splitMigrationStatements(readFileSync(path.join(dir, f), 'utf8'))) {
          await db.$executeRawUnsafe(s)
        }
      }
    }
  }, 300_000)

  afterAll(async () => {
    await db?.$disconnect().catch(() => {})
    if (dbName) await dropTestDatabase(cfg!, dbName).catch(() => {})
    if (roleName) await dropTestRole(cfg!, roleName).catch(() => {})
  }, 180_000)

  it('012 adds the two columns, and survives being applied twice', async () => {
    // run-module-migrations records what it has applied, but a migration must be
    // idempotent regardless - that rule exists because editing 001 in place once
    // took the live site down.
    const sql = readFileSync(
      path.join(process.cwd(), 'modules/google-shopping-for-shop/migrations/012_withheld_items.sql'), 'utf8',
    )
    for (const s of splitMigrationStatements(sql)) await db.$executeRawUnsafe(s)

    const cols = await db.$queryRawUnsafe<Array<{ column_name: string; data_type: string }>>(
      `SELECT "column_name", "data_type" FROM information_schema.columns
       WHERE table_name = 'gsf_settings' AND column_name IN ('withheld_items','withheld_at')
       ORDER BY column_name`,
    )
    expect(cols).toEqual([
      { column_name: 'withheld_at', data_type: 'timestamp without time zone' },
      { column_name: 'withheld_items', data_type: 'jsonb' },
    ])
  })

  it('runs the write the feed route makes, quotes and all', async () => {
    const payload = JSON.stringify({
      total: 2,
      items: [
        // A real catalogue is full of apostrophes and inch marks; the cast has to
        // survive both without the value ever being spliced into the statement.
        { id: 'a', title: `O'Brien Chair 24" Deluxe`, reason: 'no-image' },
        { id: 'b', title: 'Plain', reason: 'no-image' },
      ],
    })
    await db.$executeRaw`
      UPDATE "gsf_settings"
      SET "withheld_items" = ${payload}::jsonb, "withheld_at" = CURRENT_TIMESTAMP
      WHERE "id" = 'singleton'
    `
    const rows = await db.$queryRaw<Array<{ withheld_items: unknown; withheld_at: Date | null }>>`
      SELECT "withheld_items", "withheld_at" FROM "gsf_settings" WHERE "id" = 'singleton'
    `
    const row = rows[0]!
    expect(row.withheld_at).toBeInstanceOf(Date)
    // jsonb comes back already parsed - getWithheldReport is written expecting
    // exactly that, and would quietly return nothing if it arrived as a string.
    const stored = row.withheld_items as { total: number; items: Array<{ title: string }> }
    expect(stored.total).toBe(2)
    expect(stored.items[0]!.title).toBe(`O'Brien Chair 24" Deluxe`)
  })

  it('reads back as nothing recorded before a feed has ever been fetched', async () => {
    await db.$executeRaw`
      UPDATE "gsf_settings" SET "withheld_items" = NULL, "withheld_at" = NULL WHERE "id" = 'singleton'
    `
    const rows = await db.$queryRaw<Array<{ withheld_items: unknown; withheld_at: Date | null }>>`
      SELECT "withheld_items", "withheld_at" FROM "gsf_settings" WHERE "id" = 'singleton'
    `
    expect(rows[0]!.withheld_at).toBeNull()
    expect(rows[0]!.withheld_items).toBeNull()
  })
})
