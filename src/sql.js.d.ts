declare module "sql.js" {
  export type SqlResult = {
    values?: unknown[][]
  }

  export type SqlDatabase = {
    close(): void
    exec(sql: string, params?: unknown[]): SqlResult[]
    export(): Uint8Array
    run(sql: string, params?: unknown[]): void
  }

  export type SqlModule = {
    Database: new (data?: Uint8Array | ArrayLike<number>) => SqlDatabase
  }

  export default function initSqlJs(input?: {
    locateFile?: (file: string) => string
  }): Promise<SqlModule>
}
