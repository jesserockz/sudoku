import { type Child, Component, h } from "./dom.ts";

/** Whether the browser has the Web Share API (mostly phones): it opens the system share sheet. */
export const canShare = (): boolean => typeof navigator.share === "function";

/** Opens the share sheet. False if the browser can't share or the player cancelled. */
export async function share(data: ShareData): Promise<boolean> {
  if (!canShare()) return false;
  try {
    await navigator.share(data);
    return true;
  } catch {
    return false;
  }
}

/** Copies `text` to the clipboard. The async Clipboard API needs a secure context; older browsers use a hidden text area. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the legacy way.
  }
  const area = h("textarea", { readonly: true, style: "position: fixed; opacity: 0" });
  area.value = text;
  document.body.append(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    // Not copied.
  }
  area.remove();
  return copied;
}

/**
 * `<action-button>`: a button whose async `action` returns a message to show
 * under it, such as "Link copied." (or `null` for none).
 */
export class ActionButton extends Component {
  label = "";
  primary = false;
  action: () => Promise<string | null> = async () => null;
  #message: string | null = null;

  protected render(): Child {
    return [
      h("button", {
        class: this.primary && "primary",
        onclick: async () => {
          this.#message = await this.action();
          this.update();
        },
      }, this.label),
      this.#message && h("p", { class: "muted center action-message" }, this.#message),
    ];
  }
}

customElements.define("action-button", ActionButton);

/** An {@link ActionButton}, configured. */
export function actionButton(label: string, action: () => Promise<string | null>, primary = false): ActionButton {
  const button = document.createElement("action-button") as ActionButton;
  Object.assign(button, { label, action, primary });
  return button;
}

/** "Share results": the day's times as text, through the share sheet or the clipboard. */
export function shareResultsButton(summary: () => Promise<string>, primary = false): ActionButton {
  return actionButton("Share results", async () => {
    const text = await summary();
    if (await share({ title: "Sudoku results", text })) return null;
    return (await copyText(text)) ? "Results copied: paste them into a message." : "Couldn't copy your results.";
  }, primary);
}
