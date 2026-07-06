import { afterAll, beforeAll, describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { CustomTools } from "@opencode-ai/core/tool/custom-tools"
import { ToolPluginHooks } from "@opencode-ai/core/tool/plugin-hooks"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { executeTool, settleTool, toolDefinitions, toolIdentity } from "./lib/tool"

// Fleet fork patch coverage (see platform-v2/docs/OPENCODE-FORK.md): custom
// plugin-shape tools discovered from OPENCODE_CONFIG_DIR must flow through the
// v2 native runner's registry — the exact materialize/settle path used by
// session/runner/llm.ts. Guarded by platform-v2/scripts/build-opencode.sh.

const fixtureDir = path.join(import.meta.dir, "fixture", "fleet-tools")
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(fixtureDir) })),
)
const layer = AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, CustomTools.node]), [
  [Location.node, locationLayer],
  [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
])
const it = testEffect(layer)

const sessionID = SessionV2.ID.make("ses_fleet_custom_tools")
const call = (name: string, input: unknown, id = `call-${name}`): ToolRegistry.ExecuteInput => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call", id, name, input },
})

const previousConfigDir = process.env["OPENCODE_CONFIG_DIR"]
beforeAll(() => {
  process.env["OPENCODE_CONFIG_DIR"] = fixtureDir
})
afterAll(() => {
  if (previousConfigDir === undefined) delete process.env["OPENCODE_CONFIG_DIR"]
  else process.env["OPENCODE_CONFIG_DIR"] = previousConfigDir
})

describe("CustomTools", () => {
  it.effect("discovers custom tools from OPENCODE_CONFIG_DIR with zod-derived schemas", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const definitions = yield* toolDefinitions(registry)
      const names = definitions.map((definition) => definition.name)
      expect(names).toContain("echo")
      expect(names).toContain("echo_extra")
      expect(names).toContain("rich")
      expect(names).toContain("fail")
      expect(names).not.toContain("broken")
      const echo = definitions.find((definition) => definition.name === "echo")
      expect(echo?.inputSchema).toMatchObject({
        type: "object",
        properties: { text: { type: "string", description: "Text to echo" } },
        required: ["text"],
      })
    }),
  )

  it.effect("executes a string-result custom tool through materialize/settle", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, call("echo", { text: "hello" }))
      expect(result).toEqual({ type: "text", value: JSON.stringify({ __fleet_ui: "echo", text: "hello" }) })
    }),
  )

  it.effect("maps the V1 object result shape to structured output and content", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const settlement = yield* settleTool(registry, call("rich", { label: "x" }))
      expect(settlement.output?.structured).toEqual({ title: "rich:x", kind: "rich" })
      expect(settlement.output?.content).toEqual([
        { type: "text", text: JSON.stringify({ __fleet_ui: "rich", label: "x" }) },
        { type: "file", uri: "data:image/png;base64,AA==", mime: "image/png", name: "shot.png" },
      ])
      expect(settlement.result.type).toBe("content")
    }),
  )

  it.effect("returns an error result for input failing the tool's zod schema", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, call("echo", {}, "call-echo-invalid"))
      expect(result.type).toBe("error")
      expect(String(result.value)).toContain("Invalid tool input")
    }),
  )

  it.effect("returns an error result when the tool's execute throws", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, call("fail", { reason: "boom" }))
      expect(result).toEqual({ type: "error", value: "fail tool: boom" })
    }),
  )

  it.effect("fires the plugin tool.execute.before hook before custom tool execution", () =>
    Effect.gen(function* () {
      const uninstall = ToolPluginHooks.install(fixtureDir, {
        toolExecuteBefore: async (_input, output) => {
          if (typeof output.args["text"] === "string") output.args["text"] = `${output.args["text"]}-jailed`
        },
        shellEnv: async () => ({}),
      })
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, call("echo", { text: "raw" }, "call-echo-hook")).pipe(
        Effect.ensuring(Effect.sync(uninstall)),
      )
      expect(result).toEqual({ type: "text", value: JSON.stringify({ __fleet_ui: "echo", text: "raw-jailed" }) })
    }),
  )
})
