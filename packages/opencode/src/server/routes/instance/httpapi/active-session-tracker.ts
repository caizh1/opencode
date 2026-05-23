import { GlobalBus } from "@/bus/global"

const activeSessions = new Map<string, unknown>()

GlobalBus.on("event", (event) => {
  const p = event.payload
  if (p?.type === "session.status") {
    const { sessionID, status } = p.properties
    if (status.type === "idle") activeSessions.delete(sessionID)
    else activeSessions.set(sessionID, status)
  }
})

export function activeCount(): number {
  return activeSessions.size
}

export * as ActiveSessionTracker from "./active-session-tracker"
