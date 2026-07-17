import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  children?: ReactNode;
}

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-[#06121f] font-semibold hover:brightness-110 border border-transparent",
  secondary: "border border-strong text-ink hover:bg-white/[0.05]",
  ghost: "border border-transparent text-ink-2 hover:text-ink hover:bg-white/[0.05]",
  danger: "border border-red-500/40 text-red-400 hover:bg-red-500/10",
};

const SIZES: Record<Size, string> = {
  sm: "text-[11px] px-2.5 py-1 gap-1.5",
  md: "text-[12px] px-3 py-1.5 gap-2",
};

export default function Button({ variant = "secondary", size = "md", icon, children, className = "", ...rest }: Props) {
  return (
    <button
      className={`inline-flex items-center justify-center font-medium rounded-control transition-colors duration-fast disabled:opacity-40 disabled:pointer-events-none ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}
