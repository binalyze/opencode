import { EventEmitter } from "events"
import { Identifier } from "@/id/id"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}

class GlobalBusEmitter extends EventEmitter<{
  event: [GlobalEvent]
}> {
  // Newer @types/node model `emit` as a generic method, so a narrowed
  // ("event", GlobalEvent) override no longer satisfies the base type. Keep
  // the id-stamping behavior with a base-compatible signature instead.
  override emit(eventName: any, ...args: any[]): boolean {
    const event = args[0] as GlobalEvent | undefined
    if (event?.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
    return super.emit(eventName, ...(args as [GlobalEvent]))
  }
}

export const GlobalBus = new GlobalBusEmitter()
