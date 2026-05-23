import type { ExtensionInfo } from "../../types/extension";

type Props = {
  extension: Pick<ExtensionInfo, "id" | "name">;
  size?: "sm" | "md";
};

export function extensionIconTheme(extension: Pick<ExtensionInfo, "id" | "name">) {
  if (extension.id === "phoenix-packages") {
    return {
      box: "bg-amber-500/10 border-amber-400/25 group-hover:bg-amber-500/15",
      icon: "text-amber-300/90",
    };
  }
  return {
    box: "bg-sky-500/10 border-sky-400/20 group-hover:bg-sky-500/15",
    icon: "text-sky-300/80",
  };
}

export function ExtensionIcon({ extension, size = "md" }: Props) {
  const theme = extensionIconTheme(extension);
  const boxSize = size === "sm" ? "w-5 h-5 rounded" : "w-7 h-7 rounded-md";
  const svgSize = size === "sm" ? 12 : 15;

  return (
    <div className={`${boxSize} ${theme.box} border flex items-center justify-center shrink-0 transition-colors`}>
      {extension.id === "phoenix-packages" ? (
        <svg width={svgSize} height={svgSize} viewBox="0 0 16 16" fill="none" className={theme.icon}>
          <path d="M8 1.6 13.4 4.7v6.6L8 14.4l-5.4-3.1V4.7L8 1.6Z" stroke="currentColor" strokeWidth="1.15" strokeLinejoin="round" />
          <path d="M5.2 6.1h5.6M5.2 8h5.6M5.2 9.9h3.2" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" />
        </svg>
      ) : (
        <svg width={svgSize} height={svgSize} viewBox="0 0 16 16" fill="none" className={theme.icon}>
          <path d="M3 4.2A1.2 1.2 0 0 1 4.2 3h2.2v3.4H3V4.2ZM9.6 3h2.2A1.2 1.2 0 0 1 13 4.2v2.2H9.6V3ZM3 9.6h3.4V13H4.2A1.2 1.2 0 0 1 3 11.8V9.6ZM9.6 9.6H13v2.2a1.2 1.2 0 0 1-1.2 1.2H9.6V9.6Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
        </svg>
      )}
    </div>
  );
}
