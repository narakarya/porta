import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Spinner } from "./Feedback";

type Variant = "primary" | "accent" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  children?: ReactNode;
  /** Shows a spinner in place of the icon and disables the button. */
  loading?: boolean;
}

// Two accent treatments, both from the mockups:
//   primary — solid fill + WHITE text (commit actions: Add app, Continue,
//             wizard, update toast). Every mockup uses `color:#fff`, never dark.
//   accent  — soft accent-tint (workbench Open / Start): translucent blue bg,
//             light-blue ink, hairline accent border. Explicit rgba border so
//             the opacity survives (opacity modifiers silently drop on
//             var()-backed colors).
const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-white font-medium hover:brightness-110 border border-transparent",
  accent:
    "bg-accent-bg text-accent-ink border border-[rgba(96,165,250,0.35)] hover:bg-[rgba(96,165,250,0.22)]",
  secondary: "border border-strong text-ink hover:bg-white/[0.05]",
  ghost: "border border-transparent text-ink-2 hover:text-ink hover:bg-white/[0.05]",
  danger: "border border-red-500/40 text-red-400 hover:bg-red-500/10",
};

const SIZES: Record<Size, string> = {
  sm: "text-[11px] px-2.5 py-1 gap-1.5",
  md: "text-[12px] px-3 py-1.5 gap-2",
};

export default function Button({ variant = "secondary", size = "md", icon, children, className = "", loading = false, disabled, ...rest }: Props) {
  return (
    <button
      className={`inline-flex items-center justify-center font-medium rounded-control transition-colors duration-fast disabled:opacity-40 disabled:pointer-events-none ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={size === "sm" ? 12 : 14} /> : icon}
      {children}
    </button>
  );
}
