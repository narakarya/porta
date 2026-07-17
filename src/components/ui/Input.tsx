import type { InputHTMLAttributes, SelectHTMLAttributes, ReactNode } from "react";

const base =
  "w-full bg-surface-input border border-subtle rounded-lg px-3 py-2 text-[13px] text-ink placeholder:text-ink-3 outline-none focus:border-[rgba(96,165,250,0.6)] transition-colors duration-fast";

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${base} ${className}`} {...rest} />;
}

export function Select({ className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <select className={`${base} appearance-none ${className}`} {...rest}>
      {children}
    </select>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] text-ink-3 mb-1">{label}</span>
      {children}
    </label>
  );
}
