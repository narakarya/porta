import type { ReactNode } from "react";

interface FieldProps {
  label: string;
  hint?: string;
  children: ReactNode;
}

export default function Field({ label, hint, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[12px] font-medium text-ink-2">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-red-400">{hint}</p>}
    </div>
  );
}
