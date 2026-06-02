import type { Session } from "@opencode-ai/sdk/v2/client"
import { Avatar } from "@opencode-ai/ui/avatar"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { getFilename } from "@opencode-ai/core/util/path"
import { A, useParams } from "@solidjs/router"
import { type Accessor, createMemo, For, type JSX, Match, Show, Switch } from "solid-js"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { getAvatarColors, type LocalProject, useLayout } from "@/context/layout"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { messageAgentColor } from "@/utils/agent"
import { sessionTitle } from "@/utils/session-title"
import { getRelativeTime } from "@/utils/time"
import { sessionPermissionRequest } from "../session/composer/session-request-tree"
import { childSessionOnPath, getProjectAvatarSource, hasProjectPermissions } from "./helpers"
import type { createSessionFolderStore } from "./session-folders"

type InlineEditorComponent = (props: {
  id: string
  value: Accessor<string>
  onSave: (next: string) => void
  class?: string
  displayClass?: string
  editing?: boolean
  stopPropagation?: boolean
  openOnDblClick?: boolean
}) => JSX.Element

export const ProjectIcon = (props: {
  project: LocalProject
  class?: string
  notify?: boolean
  working?: boolean
}): JSX.Element => {
  const serverSync = useServerSync()
  const notification = useNotification()
  const permission = usePermission()
  const dirs = createMemo(() => [props.project.worktree, ...(props.project.sandboxes ?? [])])
  const unseenCount = createMemo(() =>
    dirs().reduce((total, directory) => total + notification.project.unseenCount(directory), 0),
  )
  const hasError = createMemo(() => dirs().some((directory) => notification.project.unseenHasError(directory)))
  const hasPermissions = createMemo(() =>
    dirs().some((directory) => {
      const [store] = serverSync.child(directory, { bootstrap: false })
      return hasProjectPermissions(store.permission, (item) => !permission.autoResponds(item, directory))
    }),
  )
  const notify = createMemo(() => props.notify && (hasPermissions() || unseenCount() > 0))
  const name = createMemo(() => props.project.name || getFilename(props.project.worktree))

  return (
    <div class={`relative size-8 shrink-0 rounded ${props.class ?? ""}`}>
      <div class="size-full rounded overflow-clip">
        <Avatar
          fallback={name()}
          src={getProjectAvatarSource(props.project.id, props.project.icon)}
          {...getAvatarColors(props.project.icon?.color)}
          class="size-full rounded"
          classList={{ "badge-mask": notify() }}
        />
      </div>
      <Show when={notify()}>
        <div
          classList={{
            "absolute top-px right-px size-1.5 rounded-full z-10": true,
            "bg-surface-warning-strong": hasPermissions(),
            "bg-icon-critical-base": !hasPermissions() && hasError(),
            "bg-text-interactive-base": !hasPermissions() && !hasError(),
          }}
        />
      </Show>
      <Show when={props.working}>
        <div class="absolute bottom-px right-px size-3 rounded-full bg-background-base z-10 flex items-center justify-center">
          <Spinner class="size-[9px]" />
        </div>
      </Show>
    </div>
  )
}

export type SessionItemProps = {
  session: Session
  list: Session[]
  navList?: Accessor<Session[]>
  slug: string
  mobile?: boolean
  dense?: boolean
  showTooltip?: boolean
  showChild?: boolean
  level?: number
  folderIndent?: number
  sidebarExpanded: Accessor<boolean>
  clearHoverProjectSoon: () => void
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  archiveSession: (session: Session) => Promise<void>
  renameSession: (session: Session, title: string) => Promise<void>
  editorOpen: (id: string) => boolean
  openEditor: (id: string, value: string) => void
  InlineEditor: InlineEditorComponent
  folderActions?: ReturnType<typeof createSessionFolderStore>
}

const SessionRow = (props: {
  session: Session
  slug: string
  mobile?: boolean
  dense?: boolean
  tint: Accessor<string | undefined>
  isWorking: Accessor<boolean>
  hasPermissions: Accessor<boolean>
  hasError: Accessor<boolean>
  unseenCount: Accessor<number>
  clearHoverProjectSoon: () => void
  sidebarOpened: Accessor<boolean>
  warmPress: () => void
  warmFocus: () => void
  editorID: string
  editing: Accessor<boolean>
  InlineEditor: InlineEditorComponent
  openRename: () => void
  renameSession: (title: string) => void
}): JSX.Element => {
  const language = useLanguage()
  const title = () => sessionTitle(props.session.title) ?? ""
  const updatedAt = () => props.session.time.updated ?? props.session.time.created
  const titleClass = "text-14-regular text-text-strong min-w-0 flex-1 truncate"
  const LeadingStatus = () => (
    <Show when={props.hasPermissions() || props.hasError() || props.unseenCount() > 0}>
      <div
        class="shrink-0 size-6 flex items-center justify-center"
        style={{ color: props.tint() ?? "var(--icon-interactive-base)" }}
      >
        <Switch>
          <Match when={props.hasPermissions()}>
            <div class="size-1.5 rounded-full bg-surface-warning-strong" />
          </Match>
          <Match when={props.hasError()}>
            <div class="size-1.5 rounded-full bg-text-diff-delete-base" />
          </Match>
          <Match when={props.unseenCount() > 0}>
            <div class="size-1.5 rounded-full bg-text-interactive-base" />
          </Match>
        </Switch>
      </div>
    </Show>
  )
  const TrailingStatus = () => (
    <Show
      when={props.isWorking()}
      fallback={
        <span class="shrink-0 whitespace-nowrap text-12-regular text-text-weak">
          {getRelativeTime(new Date(updatedAt()).toISOString(), language.t)}
        </span>
      }
    >
      <div
        class="shrink-0 size-6 flex items-center justify-center"
        style={{ color: props.tint() ?? "var(--icon-interactive-base)" }}
      >
        <Spinner class="size-[15px]" />
      </div>
    </Show>
  )
  const titleInput = () => (
    <props.InlineEditor
      id={props.editorID}
      value={title}
      onSave={props.renameSession}
      class={titleClass}
      displayClass={titleClass}
      editing={props.editing()}
      stopPropagation
      openOnDblClick={false}
    />
  )

  return (
    <Show
      when={props.editing()}
      fallback={
        <A
          href={`/${props.slug}/session/${props.session.id}`}
          draggable={false}
          class={`flex items-center gap-2 min-w-0 w-full text-left focus:outline-none ${props.dense ? "py-0.5" : "py-1"}`}
          onPointerDown={props.warmPress}
          onDragStart={(event) => event.preventDefault()}
          onFocus={props.warmFocus}
          onClick={() => {
            if (props.sidebarOpened()) return
            props.clearHoverProjectSoon()
          }}
        >
          <LeadingStatus />
          <span
            class={titleClass}
            onDblClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              props.openRename()
            }}
          >
            {title()}
          </span>
          <TrailingStatus />
        </A>
      }
    >
      <div class={`flex items-center gap-2 min-w-0 w-full text-left ${props.dense ? "py-0.5" : "py-1"}`}>
        <LeadingStatus />
        {titleInput()}
        <TrailingStatus />
      </div>
    </Show>
  )
}

export const SessionItem = (props: SessionItemProps): JSX.Element => {
  const params = useParams()
  const layout = useLayout()
  const language = useLanguage()
  const notification = useNotification()
  const permission = usePermission()
  const serverSync = useServerSync()
  const unseenCount = createMemo(() => notification.session.unseenCount(props.session.id))
  const hasError = createMemo(() => notification.session.unseenHasError(props.session.id))
  const [sessionStore] = serverSync.child(props.session.directory)
  const hasPermissions = createMemo(() => {
    return !!sessionPermissionRequest(sessionStore.session, sessionStore.permission, props.session.id, (item) => {
      return !permission.autoResponds(item, props.session.directory)
    })
  })
  const isWorking = createMemo(() => {
    if (hasPermissions()) return false
    return sessionStore.session_working(props.session.id)
  })

  const tint = createMemo(() => messageAgentColor(sessionStore.message[props.session.id], sessionStore.agent))
  const editorID = () => `session:${props.session.directory}:${props.session.id}`
  const title = () => sessionTitle(props.session.title) ?? ""
  const editing = createMemo(() => props.editorOpen(editorID()))
  const tooltip = createMemo(() => !editing() && (props.showTooltip ?? (props.mobile || !props.sidebarExpanded())))
  const hasFolders = createMemo(() => (props.folderActions?.folders().length ?? 0) > 0)
  const currentChild = createMemo(() => {
    if (!props.showChild) return
    return childSessionOnPath(sessionStore.session, props.session.id, params.id)
  })
  const openRename = () => props.openEditor(editorID(), title())
  const rename = (next: string) => {
    const trimmed = next.trim()
    if (!trimmed || trimmed === title()) return
    void props.renameSession(props.session, trimmed)
  }

  const warm = (span: number, priority: "high" | "low") => {
    const nav = props.navList?.()
    const list = nav?.some((item) => item.id === props.session.id && item.directory === props.session.directory)
      ? nav
      : props.list

    props.prefetchSession(props.session, priority)

    const idx = list.findIndex((item) => item.id === props.session.id && item.directory === props.session.directory)
    if (idx === -1) return

    for (let step = 1; step <= span; step++) {
      const next = list[idx + step]
      if (next) props.prefetchSession(next, step === 1 ? "high" : priority)

      const prev = list[idx - step]
      if (prev) props.prefetchSession(prev, step === 1 ? "high" : priority)
    }
  }

  const item = (
    <SessionRow
      session={props.session}
      slug={props.slug}
      mobile={props.mobile}
      dense={props.dense}
      tint={tint}
      isWorking={isWorking}
      hasPermissions={hasPermissions}
      hasError={hasError}
      unseenCount={unseenCount}
      clearHoverProjectSoon={props.clearHoverProjectSoon}
      sidebarOpened={layout.sidebar.opened}
      warmPress={() => warm(2, "high")}
      warmFocus={() => warm(2, "high")}
      editorID={editorID()}
      editing={editing}
      InlineEditor={props.InlineEditor}
      openRename={openRename}
      renameSession={rename}
    />
  )

  return (
    <>
      <div
        data-session-id={props.session.id}
        class="group/session relative w-full min-w-0 rounded-md cursor-default pr-3 transition-colors hover:bg-surface-raised-base-hover [&:has(:focus-visible)]:bg-surface-raised-base-hover has-[[data-expanded]]:bg-surface-raised-base-hover has-[.active]:bg-surface-base-active"
        style={{ "padding-left": `${8 + ((props.folderIndent ?? 0) + (props.level ?? 0)) * 16}px` }}
      >
        <div class="flex min-w-0 items-center gap-1">
          <div class="min-w-0 flex-1">
            <Show
              when={!tooltip()}
              fallback={
                <Tooltip
                  placement={props.mobile ? "bottom" : "right"}
                  value={sessionTitle(props.session.title)}
                  gutter={10}
                  class="min-w-0 w-full"
                >
                  {item}
                </Tooltip>
              }
            >
              {item}
            </Show>
          </div>

          <Show when={!props.level}>
            <div
              class="shrink-0 overflow-hidden transition-[width,opacity]"
              onPointerDown={(event) => event.stopPropagation()}
              classList={{
                "w-12 opacity-100 pointer-events-auto": !!props.mobile && hasFolders(),
                "w-6 opacity-100 pointer-events-auto": !!props.mobile && !hasFolders(),
                "w-0 opacity-0 pointer-events-none": !props.mobile,
                "group-hover/session:w-12 group-focus-within/session:w-12": hasFolders(),
                "group-hover/session:w-6 group-focus-within/session:w-6": !hasFolders(),
                "group-hover/session:opacity-100 group-hover/session:pointer-events-auto": true,
                "group-focus-within/session:opacity-100 group-focus-within/session:pointer-events-auto": true,
              }}
            >
              <div class="flex items-center gap-0">
                <Show when={hasFolders()}>
                  <DropdownMenu modal={false} placement="bottom-end">
                    <Tooltip value={language.t("session.folder.moveTo")} placement="top">
                      <DropdownMenu.Trigger
                        as={IconButton}
                        icon="folder"
                        variant="ghost"
                        class="size-6 rounded-md"
                        aria-label={language.t("session.folder.moveTo")}
                      />
                    </Tooltip>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content>
                        <DropdownMenu.Group>
                          <DropdownMenu.GroupLabel>{language.t("session.folder.moveTo")}</DropdownMenu.GroupLabel>
                          <DropdownMenu.Item onSelect={() => props.folderActions?.move(props.session.id, undefined)}>
                            <DropdownMenu.ItemLabel>{language.t("session.folder.uncategorized")}</DropdownMenu.ItemLabel>
                          </DropdownMenu.Item>
                          <DropdownMenu.Separator />
                          <For each={props.folderActions?.folders() ?? []}>
                            {(folder) => (
                              <DropdownMenu.Item onSelect={() => props.folderActions?.move(props.session.id, folder.id)}>
                                <DropdownMenu.ItemLabel>{folder.name}</DropdownMenu.ItemLabel>
                              </DropdownMenu.Item>
                            )}
                          </For>
                        </DropdownMenu.Group>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                </Show>
                <DropdownMenu modal={false} placement="bottom-end">
                  <Tooltip value={language.t("common.moreOptions")} placement="top">
                    <DropdownMenu.Trigger
                      as={IconButton}
                      icon="dot-grid"
                      variant="ghost"
                      class="size-6 rounded-md"
                      aria-label={language.t("common.moreOptions")}
                    />
                  </Tooltip>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content>
                      <DropdownMenu.Item onSelect={openRename}>
                        <DropdownMenu.ItemLabel>{language.t("common.rename")}</DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                      <DropdownMenu.Item onSelect={() => void props.archiveSession(props.session)}>
                        <DropdownMenu.ItemLabel>{language.t("common.archive")}</DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu>
              </div>
            </div>
          </Show>
        </div>
      </div>
      <Show when={currentChild()} keyed>
        {(child) => (
          <div class="w-full">
            <SessionItem {...props} session={child} level={(props.level ?? 0) + 1} />
          </div>
        )}
      </Show>
    </>
  )
}

export const NewSessionItem = (props: {
  slug: string
  mobile?: boolean
  dense?: boolean
  sidebarExpanded: Accessor<boolean>
  clearHoverProjectSoon: () => void
}): JSX.Element => {
  const layout = useLayout()
  const language = useLanguage()
  const label = language.t("command.session.new")
  const tooltip = () => props.mobile || !props.sidebarExpanded()
  const item = (
    <A
      href={`/${props.slug}/session`}
      end
      class={`flex items-center gap-2 min-w-0 w-full text-left focus:outline-none ${props.dense ? "py-0.5" : "py-1"}`}
      onClick={() => {
        if (layout.sidebar.opened()) return
        props.clearHoverProjectSoon()
      }}
    >
      <div class="shrink-0 size-6 flex items-center justify-center">
        <Icon name="new-session" size="small" class="text-icon-weak" />
      </div>
      <span class="text-14-regular text-text-strong min-w-0 flex-1 truncate">{label}</span>
    </A>
  )

  return (
    <div class="group/session relative w-full min-w-0 rounded-md cursor-default transition-colors pl-2 pr-3 hover:bg-surface-raised-base-hover [&:has(:focus-visible)]:bg-surface-raised-base-hover has-[.active]:bg-surface-base-active">
      <Show
        when={!tooltip()}
        fallback={
          <Tooltip placement={props.mobile ? "bottom" : "right"} value={label} gutter={10} class="min-w-0 w-full">
            {item}
          </Tooltip>
        }
      >
        {item}
      </Show>
    </div>
  )
}

export const SessionSkeleton = (props: { count?: number }): JSX.Element => {
  const items = Array.from({ length: props.count ?? 4 }, (_, index) => index)
  return (
    <div class="flex flex-col gap-1">
      <For each={items}>
        {() => <div class="h-8 w-full rounded-md bg-surface-raised-base opacity-60 animate-pulse" />}
      </For>
    </div>
  )
}
