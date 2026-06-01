import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { SessionID } from "./schema"
import { Effect, Layer, Context, Schema } from "effect"
import { Database } from "@/storage/db"
import { eq } from "drizzle-orm"
import { asc } from "drizzle-orm"
import { TodoTable } from "./session.sql"
import { ulid } from "ulid"

export const Info = Schema.Struct({
  id: Schema.String.annotate({ description: "Unique identifier for the todo item" }),
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Schema.String.annotate({
    description: "Current status of the task: pending, in_progress, completed, cancelled",
  }),
  priority: Schema.String.annotate({ description: "Priority level of the task: high, medium, low" }),
}).annotate({ identifier: "Todo" })
export type Info = Schema.Schema.Type<typeof Info>

export const Input = Schema.Struct({
  id: Schema.optional(Schema.String).annotate({ description: "Stable identifier for the todo item" }),
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Schema.String.annotate({
    description: "Current status of the task: pending, in_progress, completed, cancelled",
  }),
  priority: Schema.String.annotate({ description: "Priority level of the task: high, medium, low" }),
})
export type Input = Schema.Schema.Type<typeof Input>

export const Event = {
  Updated: BusEvent.define(
    "todo.updated",
    Schema.Struct({
      sessionID: SessionID,
      todos: Schema.Array(Info),
    }),
  ),
}

export interface Interface {
  readonly update: (input: { sessionID: SessionID; todos: Input[] }) => Effect.Effect<Info[]>
  readonly get: (sessionID: SessionID) => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTodo") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const update = Effect.fn("Todo.update")(function* (input: { sessionID: SessionID; todos: Input[] }) {
      const todos = yield* Effect.sync(() =>
        Database.use((db) => {
          const existing = db
            .select()
            .from(TodoTable)
            .where(eq(TodoTable.session_id, input.sessionID))
            .orderBy(asc(TodoTable.position))
            .all()
          const byContent = existing.reduce((result, row) => {
            result.set(row.content, [...(result.get(row.content) ?? []), row])
            return result
          }, new Map<string, typeof existing>())
          const used = new Set<string>()
          return input.todos.map((todo, position) => {
            const next = todo.id || byContent.get(todo.content)?.shift()?.id || existing[position]?.id || ulid()
            const id = used.has(next) ? ulid() : next
            used.add(id)
            return {
              id,
              content: todo.content,
              status: todo.status,
              priority: todo.priority,
            }
          })
        }),
      )
      yield* Effect.sync(() =>
        Database.transaction((db) => {
          db.delete(TodoTable).where(eq(TodoTable.session_id, input.sessionID)).run()
          if (todos.length === 0) return
          db.insert(TodoTable)
            .values(
              todos.map((todo, position) => ({
                session_id: input.sessionID,
                id: todo.id,
                content: todo.content,
                status: todo.status,
                priority: todo.priority,
                position,
              })),
            )
            .run()
        }),
      )
      yield* bus.publish(Event.Updated, { sessionID: input.sessionID, todos })
      return todos
    })

    const get = Effect.fn("Todo.get")(function* (sessionID: SessionID) {
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db.select().from(TodoTable).where(eq(TodoTable.session_id, sessionID)).orderBy(asc(TodoTable.position)).all(),
        ),
      )
      return rows.map((row) => ({
        id: row.id,
        content: row.content,
        status: row.status,
        priority: row.priority,
      }))
    })

    return Service.of({ update, get })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as Todo from "./todo"
