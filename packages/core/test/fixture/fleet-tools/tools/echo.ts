import z from "zod"

// Plugin-shape custom tool fixture (matches @opencode-ai/plugin `tool()`,
// which is an identity function — no import needed here).
export default {
  description: "Echo text back as a Fleet UI envelope",
  args: { text: z.string().describe("Text to echo") },
  async execute(args: { text: string }) {
    return JSON.stringify({ __fleet_ui: "echo", text: args.text })
  },
}

export const extra = {
  description: "Named-export variant",
  args: { value: z.number() },
  async execute(args: { value: number }) {
    return `extra:${args.value}`
  },
}
