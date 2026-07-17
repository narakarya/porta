import { EmptyState } from "../ui";

// Extensions domain — install/manage (running happens as workbench tabs).
// Phase 1 ships the shell placeholder; the manager is built in the Extensions phase.
export default function ExtensionsView() {
  return (
    <EmptyState
      icon={
        <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
          <path d="M6 2.5a1.3 1.3 0 112.6 0V4h2.4a.6.6 0 01.6.6V7h1.4a1.3 1.3 0 110 2.6H11.6V13a.6.6 0 01-.6.6H8.6V12a1.3 1.3 0 10-2.6 0v1.6H3.4a.6.6 0 01-.6-.6V9.6H4a1.3 1.3 0 100-2.6H2.8V4.6A.6.6 0 013.4 4H6V2.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      }
      title="Extensions"
      hint="Install, enable, and manage extensions here. They run as tabs on the apps they activate for."
    />
  );
}
