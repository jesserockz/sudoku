/**
 * Stops the page zooming and its text being selected while a game is on screen, so a fast tap, a pinch or a long
 * press on the board never moves the page from under the player's fingers.
 *
 * The `playing` class on the root element carries the CSS (`touch-action`, `user-select` and the long-press
 * callout, in `styles.css`). Safari ignores `user-scalable=no` and, on older versions, parts of `touch-action`, so
 * its own `gesturestart` (a pinch beginning) is cancelled too; no other browser fires it. Zooming from the browser's
 * own menu or keyboard shortcuts (Ctrl +, Ctrl and the wheel) is the player's choice and is not touched.
 */

/** The class set on the root element while a game is on screen. */
export const PLAYING_CLASS = "playing";

/** The part of a document `lockZoom` uses. */
export interface ZoomLockTarget {
  readonly documentElement: { readonly classList: { add(name: string): void; remove(name: string): void } };
  addEventListener(type: string, listener: (e: Event) => void, options: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: (e: Event) => void): void;
}

const cancel = (e: Event): void => e.preventDefault();

/** Locks zooming and selection on `doc`, and returns the function that unlocks them again. */
export function lockZoom(doc: ZoomLockTarget): () => void {
  doc.documentElement.classList.add(PLAYING_CLASS);
  // Not passive: a passive listener can't cancel the gesture.
  doc.addEventListener("gesturestart", cancel, { passive: false });
  return () => {
    doc.documentElement.classList.remove(PLAYING_CLASS);
    doc.removeEventListener("gesturestart", cancel);
  };
}
