import { EmptyState } from "../ui";

// Activity domain — consolidates resources, disk, updates, events, containers.
// Phase 1 ships the shell placeholder; the dashboard is built in the Activity phase.
export default function ActivityView() {
  return (
    <EmptyState
      icon={
        <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
          <path d="M1.5 8.5h3l2-5 3 9 2-4h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      }
      title="Activity"
      hint="Resources, disk, updates, events, and container observability will live here."
    />
  );
}
