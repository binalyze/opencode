import z from "zod"

export default {
  description: "Always throws",
  args: { reason: z.string() },
  async execute(args: { reason: string }): Promise<string> {
    throw new Error(`fail tool: ${args.reason}`)
  },
}
