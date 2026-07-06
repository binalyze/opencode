import z from "zod"

// Exercises the V1 object result shape: title/output/metadata/attachments.
export default {
  description: "Returns the V1 object result shape",
  args: { label: z.string() },
  async execute(args: { label: string }) {
    return {
      title: `rich:${args.label}`,
      output: JSON.stringify({ __fleet_ui: "rich", label: args.label }),
      metadata: { kind: "rich" },
      attachments: [
        { type: "file" as const, mime: "image/png", url: "data:image/png;base64,AA==", filename: "shot.png" },
      ],
    }
  },
}
