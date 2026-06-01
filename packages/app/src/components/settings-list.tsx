import { type Component, type JSX } from "solid-js"

export const SettingsList: Component<{ children: JSX.Element }> = (props) => {
  return (
    <div data-component="settings-list" class="bg-surface-base px-4 rounded-lg">
      {props.children}
    </div>
  )
}
