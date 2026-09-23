import { createPortal } from "react-dom";
import type { ReactNode } from "react";

/**
 * Renders children into `document.body` instead of their normal React
 * position. Every full-screen overlay (a modal backdrop, a toast) needs
 * this: rendered in place, a `position: fixed` element is only guaranteed
 * to cover the viewport if NO ancestor happens to establish a containing
 * block (an active `transform`/`filter`/`perspective`/`will-change`
 * anywhere above it - including a transient one left behind by a CSS
 * animation's fill-mode). That is easy to break by accident anywhere else
 * in the app and hard to notice locally, so overlays opt out of the
 * ancestor chain entirely rather than relying on nobody upstream ever
 * doing that.
 */
export function Portal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}
