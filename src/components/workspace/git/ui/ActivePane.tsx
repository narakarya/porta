import { createContext, useContext, type ReactNode } from "react";

/**
 * True unless a pane says otherwise, so a tab rendered on demand — which is
 * every tab but Status — needs no provider and no opt-in to keep working.
 */
const ActivePaneContext = createContext(true);

/**
 * Whether the pane this component sits in is the one on screen.
 *
 * A pane that is kept mounted while hidden (Status, to save its commit draft)
 * would otherwise go on refetching behind `display:none`. Read this and skip —
 * don't unmount, and don't throw state away. Put it in the dependency list of
 * whatever it gates: the pane must come back with fresh data, not with what it
 * had when the user left it.
 */
export function useActivePane(): boolean {
  return useContext(ActivePaneContext);
}

/**
 * A pane slot that hides its child instead of dropping it, and tells the child
 * it is hidden. `className` applies while active; hidden means the `hidden`
 * attribute (keeping it out of the a11y tree) plus display:none.
 *
 * The slot has to keep a fixed position among its siblings for React to keep
 * the mount — that, not the JSX being written once, is what preserves state.
 */
export default function ActivePane({
  active,
  className = "",
  children,
}: {
  active: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={active ? className : "hidden"} hidden={!active}>
      <ActivePaneContext.Provider value={active}>{children}</ActivePaneContext.Provider>
    </div>
  );
}
