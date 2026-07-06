export * as CustomTools from "./custom-tools"

/**
 * Fleet fork patch (see platform-v2/docs/OPENCODE-FORK.md): discover
 * plugin-shape custom tools ({tool,tools}/*.{js,ts} under
 * OPENCODE_CONFIG_DIR) and register them with the v2 native runner's
 * ToolRegistry. The V1 engine did this in
 * packages/opencode/src/tool/registry.ts (custom tool scan + `fromPlugin`);
 * that discovery was never ported to the v2 runner, which otherwise exposes
 * only the built-in tools. The Zod→JSON-Schema helpers below are ported
 * verbatim from the V1 registry so both engines advertise identical schemas.
 */

import type { JSONSchema7, JSONSchema7Definition } from "@ai-sdk/provider"
import { ToolOutput } from "@opencode-ai/llm"
import type { ToolContext as PluginToolContext, ToolDefinition as PluginToolDefinition } from "@opencode-ai/plugin"
import { Effect, Layer, type JsonSchema, type Scope } from "effect"
import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import { makeLocationNode } from "../effect/app-node"
import { Flag } from "../flag/flag"
import { Location } from "../location"
import { Glob } from "../util/glob"
import { ToolRegistry } from "./registry"
import { fromJsonSchema, validateName, type AnyTool, type RegistrationError } from "./tool"
import { Tools } from "./tools"

type RegisterFn = (tools: Readonly<Record<string, AnyTool>>) => Effect.Effect<void, RegistrationError, Scope.Scope>

/** Scan every custom tool file shipped in OPENCODE_CONFIG_DIR (none when the flag is unset, e.g. dev machines). */
const discover = () => {
  const dir = Flag.OPENCODE_CONFIG_DIR
  if (!dir) return []
  return Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true })
}

export const register = (registerFn: RegisterFn, location: Location.Interface) =>
  Effect.gen(function* () {
    for (const match of discover()) {
      const namespace = path.basename(match, path.extname(match))
      const mod = yield* Effect.tryPromise({
        try: () => import(pathToFileURL(match).href) as Promise<Record<string, unknown>>,
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("custom tool import failed, skipping", { path: match, error }).pipe(Effect.as(undefined)),
        ),
      )
      if (!mod) continue
      for (const [exportId, def] of Object.entries(mod)) {
        if (!isPluginTool(def)) continue
        const name = exportId === "default" ? namespace : `${namespace}_${exportId}`
        const tool = yield* Effect.try({
          try: () => fromPlugin(def, location),
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) =>
            Effect.logError("custom tool is invalid, skipping", { name, path: match, error }).pipe(
              Effect.as(undefined),
            ),
          ),
        )
        if (!tool) continue
        yield* Effect.gen(function* () {
          yield* validateName(name)
          yield* registerFn({ [name]: tool })
        }).pipe(
          Effect.catch((error) =>
            Effect.logError("custom tool failed to register, skipping", { name, path: match, error }),
          ),
        )
      }
    }
  })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const location = yield* Location.Service
    yield* register(tools.register, location)
  }),
)

export const node = makeLocationNode({
  name: "tool/custom-tools",
  layer,
  deps: [ToolRegistry.node, Location.node],
})

/** Adapt a V1 plugin-shape tool ({description, args: ZodRawShape, execute}) to a v2 core tool. */
function fromPlugin(def: PluginToolDefinition, location: Location.Interface): AnyTool {
  // Normalize missing args to `{}` once — pre-1.14.49 the code was
  // `z.object(def.args)` and Zod silently tolerated undefined (#27451, #27630).
  const args = def.args ?? {}
  const entries = Object.entries(args)
  const allZod = entries.every((entry) => isZodType(entry[1]))
  const zodParams = allZod ? z.object(args) : undefined
  const jsonSchema = zodParams ? zodJsonSchema(zodParams) : legacyJsonSchema(entries)
  return fromJsonSchema({
    description: def.description,
    inputSchema: jsonSchema as JsonSchema.JsonSchema,
    execute: async (input, context, signal) => {
      let parsed = (input ?? {}) as Record<string, unknown>
      if (zodParams) {
        const result = zodParams.safeParse(parsed)
        if (!result.success) throw new Error(`Invalid tool input: ${z.prettifyError(result.error)}`)
        parsed = result.data
      }
      const pluginCtx: PluginToolContext = {
        sessionID: context.sessionID,
        messageID: context.assistantMessageID,
        agent: context.agent,
        directory: location.directory,
        worktree: location.project.directory,
        abort: signal,
        // The v2 runner has no incremental tool metadata channel and custom
        // tools run without interactive permission prompts (parity with V1
        // container config, where all custom tools were allowed).
        metadata: () => {},
        ask: async () => {},
      }
      const result = await def.execute(parsed as never, pluginCtx)
      const output = typeof result === "string" ? result : result.output
      const title = typeof result === "string" ? undefined : result.title
      const metadata = typeof result === "string" ? undefined : result.metadata
      const attachments = typeof result === "string" ? undefined : result.attachments
      return ToolOutput.make({ ...(title ? { title } : {}), ...(metadata ?? {}) }, [
        { type: "text", text: output },
        ...(attachments ?? []).map((attachment) => ({
          type: "file" as const,
          uri: attachment.url,
          mime: attachment.mime,
          name: attachment.filename,
        })),
      ])
    },
  })
}

function isZodType(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value
}

function isPluginTool(value: unknown): value is PluginToolDefinition {
  return typeof value === "object" && value !== null && "args" in value && "description" in value && "execute" in value
}

function isJsonSchemaDefinition(value: unknown): value is JSONSchema7Definition {
  return typeof value === "boolean" || (typeof value === "object" && value !== null && !Array.isArray(value))
}

function legacyJsonSchema(entries: [string, unknown][]): JSONSchema7 {
  const properties = Object.fromEntries(
    entries.filter((entry): entry is [string, JSONSchema7Definition] => isJsonSchemaDefinition(entry[1])),
  )
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
  }
}

function zodJsonSchema(schema: z.ZodType): JSONSchema7 {
  const result = normalizeZodJsonSchema(z.toJSONSchema(schema, { io: "input", metadata: zodMetadataRegistry(schema) }))
  if (!isJsonSchemaObject(result)) throw new Error("plugin tool Zod schema produced a non-object JSON Schema")
  const { $defs, ...rest } = result
  return (
    $defs && isJsonSchemaObject($defs) ? { ...rest, definitions: $defs as JSONSchema7["definitions"] } : rest
  ) as JSONSchema7
}

function zodMetadataRegistry(schema: z.ZodType) {
  const registry = z.registry<Record<string, unknown>>()
  const seen = new WeakSet<object>()
  const collect = (value: unknown) => {
    if (typeof value !== "object" || value === null) return
    if (seen.has(value)) return
    seen.add(value)

    if (isZodType(value)) {
      const metadata = typeof value.meta === "function" ? value.meta() : undefined
      const description = typeof value.description === "string" ? value.description : undefined
      const merged = {
        ...(metadata && typeof metadata === "object" ? metadata : {}),
        ...(description ? { description } : {}),
      }
      if (Object.keys(merged).length) registry.add(value, merged)
      collect(value._zod.def)
      return
    }

    for (const item of Object.values(value)) collect(item)
  }
  collect(schema)
  return registry
}

function normalizeZodJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeZodJsonSchema(item))
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) =>
        (entry[0] === "exclusiveMaximum" || entry[0] === "exclusiveMinimum") && typeof entry[1] === "boolean"
          ? false
          : true,
      )
      .map(([key, item]) => [key, normalizeZodJsonSchema(item)]),
  )
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
