import {
  ArrowClockwise,
  CircleNotch,
  DownloadSimple,
  Trash,
  type Icon,
  type IconWeight,
} from "@phosphor-icons/react";

/**
 * Shared glyphs for the states every async surface goes through: refreshing,
 * fetching, downloading, clearing.
 *
 * These used to be open-coded per call site — a bare `↻` character (which
 * renders in the UI font, at the wrong weight, and can't animate) and a
 * one-path 3/4 arc that reads as a broken circle rather than a spinner — and
 * they drifted in size and stroke between screens. Phosphor is already a
 * dependency, so the shapes come from there; the wrappers only exist to pin
 * the default size/weight so a refresh button looks the same everywhere.
 *
 * Anything not covered here can import from `@phosphor-icons/react` directly.
 */

interface IconProps {
  size?: number;
  className?: string;
  weight?: IconWeight;
}

function wrap(Glyph: Icon, defaultSize: number, defaultWeight: IconWeight = "bold") {
  return function Wrapped({ size = defaultSize, className = "", weight = defaultWeight }: IconProps) {
    return <Glyph size={size} weight={weight} className={`shrink-0 ${className}`} aria-hidden />;
  };
}

/** Circular arrow — "fetch again". Pass `spinning` while the fetch is in flight. */
export function RefreshIcon({ size = 12, className = "", weight = "bold", spinning = false }: IconProps & { spinning?: boolean }) {
  return (
    <ArrowClockwise
      size={size}
      weight={weight}
      aria-hidden
      className={`shrink-0 ${spinning ? "animate-spin" : ""} ${className}`}
    />
  );
}

/** Arrow into a tray — download / export to a file. */
export const DownloadIcon = wrap(DownloadSimple, 15);

/**
 * The log viewer's clear button used to be a hand-drawn broom, which at 15px
 * is an unrecognisable diagonal scribble. A trash can is the shape everyone
 * already reads as "and it's gone".
 */
export const ClearIcon = wrap(Trash, 15, "regular");

/** The raw spinner glyph, for places that want it without the Spinner wrapper. */
export const SpinnerGlyph = CircleNotch;
