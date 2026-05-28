import { createEffect, onCleanup, onMount } from "solid-js"
import type { Extension } from "@codemirror/state"
import { EditorState } from "@codemirror/state"
import { EditorView, keymap } from "@codemirror/view"
import { markdown } from "@codemirror/lang-markdown"
import { python } from "@codemirror/lang-python"
import { cpp } from "@codemirror/lang-cpp"
import { javascript } from "@codemirror/lang-javascript"
import { html } from "@codemirror/lang-html"
import { xml } from "@codemirror/lang-xml"
import { css } from "@codemirror/lang-css"
import { json } from "@codemirror/lang-json"
import { yaml } from "@codemirror/lang-yaml"
import { sql } from "@codemirror/lang-sql"
import { basicSetup } from "codemirror"
import { editorLanguageFromPath } from "@/context/file/edit"

export function FileEditor(props: {
  path: string
  value: string
  class?: string
  onChange: (value: string) => void
  onSave: VoidFunction
}) {
  let host: HTMLDivElement | undefined
  let view: EditorView | undefined

  const theme = EditorView.theme({
    "&": {
      height: "100%",
      backgroundColor: "var(--background-base)",
      color: "var(--text-base)",
      fontSize: "13px",
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      lineHeight: "1.6",
    },
    ".cm-content": {
      padding: "12px 0 32px",
      minHeight: "100%",
    },
    ".cm-line": {
      padding: "0 16px",
    },
    ".cm-gutters": {
      backgroundColor: "var(--background-base)",
      color: "var(--text-weak)",
      borderRight: "1px solid var(--border-weak-base)",
    },
    ".cm-activeLine, .cm-activeLineGutter": {
      backgroundColor: "color-mix(in srgb, var(--surface-raised-base) 70%, transparent)",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "color-mix(in srgb, var(--surface-interactive-base) 36%, transparent)",
    },
  })

  const languageExtension = (): Extension => {
    const language = editorLanguageFromPath(props.path)
    if (language === "markdown") return markdown()
    if (language === "python") return python()
    if (language === "cpp") return cpp()
    if (language === "javascript") return javascript()
    if (language === "typescript") return javascript({ typescript: true })
    if (language === "jsx") return javascript({ jsx: true })
    if (language === "tsx") return javascript({ typescript: true, jsx: true })
    if (language === "html") return html()
    if (language === "xml") return xml()
    if (language === "css") return css()
    if (language === "json") return json()
    if (language === "yaml") return yaml()
    if (language === "sql") return sql()
    return []
  }

  onMount(() => {
    if (!host) return
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          basicSetup,
          languageExtension(),
          EditorView.lineWrapping,
          theme,
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                props.onSave()
                return true
              },
            },
          ]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return
            props.onChange(update.state.doc.toString())
          }),
        ],
      }),
    })
  })

  createEffect(() => {
    const next = props.value
    const editor = view
    if (!editor) return
    if (editor.state.doc.toString() === next) return
    editor.dispatch({
      changes: {
        from: 0,
        to: editor.state.doc.length,
        insert: next,
      },
    })
  })

  onCleanup(() => {
    view?.destroy()
  })

  return <div ref={host} class={props.class} />
}
