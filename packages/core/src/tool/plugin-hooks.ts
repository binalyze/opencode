export * as ToolPluginHooks from "./plugin-hooks"

/**
 * Bridge for the V1 plugin tool hooks (`tool.execute.before`, `shell.env`)
 * into the V2 native tool path.
 *
 * The native session runner executes tools through `ToolRegistry.settle` and
 * the core `BashTool`, neither of which consults the plugin system — the V1
 * session loop that used to fire these hooks is bypassed entirely, silently
 * dropping documented plugin API hooks (core bash carried a TODO for exactly
 * this). The plugin service (packages/opencode) installs a per-directory
 * runner here when an instance's plugins finish loading; core consults it
 * around tool execution.
 *
 * Plain promises on purpose: the plugin system's per-instance Effect context
 * does not exist inside core's location layer graph, and the hooks array is
 * already materialized by the time the runner is installed.
 */
export type Runner = {
  readonly toolExecuteBefore: (
    input: { readonly tool: string; readonly sessionID: string; readonly callID: string },
    output: { readonly args: Record<string, unknown> },
  ) => Promise<void>
  readonly shellEnv: (input: {
    readonly sessionID?: string
    readonly cwd: string
  }) => Promise<Record<string, string>>
  /**
   * V1 `experimental.chat.system.transform`: hooks append/edit system-prompt
   * blocks in place (per-session context like the thread-workspace path, user
   * memories, and the agent-builder edit target). The native runner assembles
   * its system prompt without the V1 request path that used to fire this.
   */
  readonly chatSystemTransform: (
    input: { readonly sessionID?: string },
    output: { readonly system: string[] },
  ) => Promise<void>
}

const runners = new Map<string, Runner>()

export const install = (directory: string, runner: Runner): (() => void) => {
  runners.set(directory, runner)
  return () => {
    if (runners.get(directory) === runner) runners.delete(directory)
  }
}

export const get = (directory: string): Runner | undefined => runners.get(directory)
