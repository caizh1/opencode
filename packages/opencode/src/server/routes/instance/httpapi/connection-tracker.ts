const connections = new Set<string>()
let counter = 0

export function register(): string {
  const id = String(++counter)
  connections.add(id)
  return id
}

export function unregister(id: string): void {
  connections.delete(id)
}

export function count(): number {
  return connections.size
}

export * as ConnectionTracker from "./connection-tracker"
