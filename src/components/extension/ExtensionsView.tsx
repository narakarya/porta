import { lazy, Suspense } from "react";
import { Skeleton } from "../ui";

// Extensions domain — the full install/enable/update/uninstall manager.
// Reuses the settings ExtensionsSection (self-contained) so there is a single
// source of truth for extension management; extensions still *run* as workbench
// tabs on the apps they activate for.
const ExtensionsSection = lazy(() => import("../settings/ExtensionsSection"));

export default function ExtensionsView() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto">
        <Suspense
          fallback={
            <div className="space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          }
        >
          <ExtensionsSection />
        </Suspense>
      </div>
    </div>
  );
}
