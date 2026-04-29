import { Hono } from "hono"
import { stream } from "hono/streaming"
import { Database } from "../../storage/db"
import {
  ProjectTable,
  SessionTable,
  MessageTable,
  PartTable,
  TodoTable,
  PermissionTable,
  SessionShareTable,
  WorkspaceTable,
} from "../../storage/schema"

// Bumped only when the on-wire row shape changes incompatibly. Replays of older
// dumps are rejected fast in /import; we never silently drift across formats.
const FORMAT_VERSION = 1

// Order matters: parents come before their FK children so a fresh import never
// hits a constraint failure.
const TABLES = [
  { name: "project", table: ProjectTable },
  { name: "workspace", table: WorkspaceTable },
  { name: "permission", table: PermissionTable },
  { name: "session", table: SessionTable },
  { name: "session_share", table: SessionShareTable },
  { name: "message", table: MessageTable },
  { name: "part", table: PartTable },
  { name: "todo", table: TodoTable },
] as const

const TABLE_BY_NAME = new Map(TABLES.map((entry) => [entry.name, entry.table] as const))

type Header = { v: number; ts: number; tables: string[] }
type RowLine = { t: string; r: Record<string, unknown> }

function parseLine<T>(line: string): T {
  return JSON.parse(line) as T
}

export const BackupRoutes = () =>
  new Hono()
    .post("/export", async (c) => {
      c.header("Content-Type", "application/x-ndjson")
      return stream(c, async (s) => {
        const header: Header = {
          v: FORMAT_VERSION,
          ts: Date.now(),
          tables: TABLES.map((entry) => entry.name),
        }
        await s.write(JSON.stringify(header) + "\n")
        for (const { name, table } of TABLES) {
          const rows = Database.use((db) => db.select().from(table).all())
          for (const r of rows) {
            const line: RowLine = { t: name, r: r as Record<string, unknown> }
            await s.write(JSON.stringify(line) + "\n")
          }
        }
      })
    })
    .post("/import", async (c) => {
      const body = await c.req.text()
      const lines = body.split("\n").filter((line) => line.trim().length > 0)
      if (lines.length === 0) {
        return c.json({ error: "empty body" }, 400)
      }

      let header: Header
      try {
        header = parseLine<Header>(lines[0])
      } catch {
        return c.json({ error: "missing or invalid header" }, 400)
      }
      if (header.v !== FORMAT_VERSION) {
        return c.json({ error: `unsupported format version ${header.v}` }, 400)
      }

      const groups = new Map<string, Record<string, unknown>[]>()
      for (const { name } of TABLES) groups.set(name, [])

      for (let i = 1; i < lines.length; i++) {
        const { t, r } = parseLine<RowLine>(lines[i])
        const bucket = groups.get(t)
        if (bucket) bucket.push(r)
      }

      const counts: Record<string, number> = {}
      Database.transaction((db) => {
        for (const { name, table } of TABLES) {
          const rows = groups.get(name) ?? []
          counts[name] = rows.length
          if (rows.length === 0) continue
          db.insert(table)
            .values(rows as never[])
            .onConflictDoNothing()
            .run()
        }
      })

      return c.json({ v: FORMAT_VERSION, imported: counts })
    })
