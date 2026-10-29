/** What `h` accepts as children: nodes, text, and nested lists; `null`, `undefined` and `false` are skipped. */
export type Child = Node | string | number | null | undefined | false | Child[];

/**
 * Element properties for `h`: `class` takes a string or a list (falsy entries
 * skipped), `onclick`-style keys add event listeners, `value` sets the
 * property, and anything else is an attribute (`true` for a bare attribute,
 * `false`/`null`/`undefined` to leave it out).
 */
export type Props = Record<string, unknown>;

/** Creates an element: `h("button", { class: "primary", onclick: go }, "Play")`. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K];
export function h(tag: string, props?: Props | null, ...children: Child[]): HTMLElement;
export function h(tag: string, props?: Props | null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (key === "class") {
      const names = Array.isArray(value) ? value.filter(Boolean) : [value];
      if (names.length && names[0]) el.className = names.join(" ");
    } else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2), value as EventListener);
    } else if (key === "value") {
      (el as HTMLInputElement).value = String(value);
    } else if (value === true) {
      el.setAttribute(key, "");
    } else if (value !== false && value !== null && value !== undefined) {
      el.setAttribute(key, String(value));
    }
  }
  el.append(...flatten(children));
  return el;
}

function flatten(children: Child[]): (Node | string)[] {
  const out: (Node | string)[] = [];
  for (const c of children) {
    if (Array.isArray(c)) out.push(...flatten(c));
    else if (c !== null && c !== undefined && c !== false) out.push(typeof c === "number" ? String(c) : c);
  }
  return out;
}

/**
 * Base for the app's custom elements. They render into their own light DOM
 * (so the global stylesheet applies) by returning children from `render()`;
 * `update()` re-renders. Elements with state that must survive an update,
 * like a half-typed form, override `update()`.
 */
export abstract class Component extends HTMLElement {
  connectedCallback(): void {
    this.update();
  }

  update(): void {
    this.replaceChildren(...flatten([this.render()]));
  }

  protected abstract render(): Child;
}

/** The header every screen starts with: an optional back link, the title, and trailing actions. */
export function topBar(title: string, onBack?: (() => void) | null, ...trailing: Child[]): HTMLElement {
  return h("header", { class: "bar" },
    onBack ? h("button", { class: "link", onclick: onBack }, "‹ Back") : null,
    h("h1", null, title),
    h("div", null, trailing),
  );
}
