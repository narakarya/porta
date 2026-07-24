# Access Popover Design QA

## Evidence

- Primary source visual truth:
  `/Users/nasrulgunawan/.codex/generated_images/019f7bca-ed27-75e3-af45-564e1b2eaca8/call_7ftBtfiBVkIvGdzBAS6QnxC4.png`
- Access-control source visual truth:
  `/var/folders/15/334ft93j4ll_xmvqx89pwhjw0000gn/T/codex-clipboard-46dc7996-2cde-4f25-8fe4-49c2bfa91c59.png`
- Collapsed implementation screenshot:
  `/tmp/porta-design-qa/porta-access-debug-collapsed.png`
- Expanded tunnel-output screenshot:
  `/tmp/porta-design-qa/porta-access-debug-expanded.png`
- Routes & Access source screenshots:
  `/tmp/porta-access-audit/02b-domain-advanced.png` and
  `/tmp/porta-access-audit/03-tunneling-config.png`
- Routes & Access implementation screenshots:
  `/tmp/porta-design-qa/porta-routes-access-drawer-advanced.png` and
  `/tmp/porta-design-qa/porta-routes-access-public-tunnel.png`
- Streamlined Config screenshot:
  `/tmp/porta-design-qa/porta-config-without-access-duplicates.png`
- Full-view comparison evidence:
  `/tmp/porta-design-qa/porta-access-debug-full-comparison.png`,
  `/tmp/porta-design-qa/porta-routes-access-local-comparison.png`, and
  `/tmp/porta-design-qa/porta-routes-access-tunnel-comparison.png`
- Focused access-control comparison evidence:
  `/tmp/porta-design-qa/porta-access-controls-comparison.png`
- Viewport: 1440 × 1024
- State: primary app running, Open popover expanded, Quick Tunnel connected,
  three local destinations and one ephemeral public destination visible.
  Tunnel output was checked in both its default-collapsed and expanded states.
  The Routes & Access drawer was checked with Local Routes expanded to its
  advanced settings and with Public Tunnel selected.

## Fidelity Review

- Layout: Passed. The connected Open/status/chevron trigger, two-column
  popover, destination rows, tunnel controls, access selector, and collapsed
  output row preserve the source hierarchy. The production popover is
  intentionally denser so it fits Porta's existing workbench header.
- Typography: Passed. Existing Porta font sizes, weights, labels, and muted
  text tokens are reused. The access-control label, button text, and hierarchy
  match the provided crop.
- Color and surfaces: Passed. Existing dark surface, border, blue selection,
  green live-state, and hover tokens match the surrounding product.
- Image quality and icons: Passed. No raster assets were substituted or
  degraded. Phosphor icons are used consistently for browser, copy,
  destination, access, tunnel, and debug actions.
- Content: Passed. Quick exposes exactly one ephemeral `trycloudflare.com`
  destination; Named exposes all configured hostnames. Every local subdomain is
  listed separately. Public, Password, and CF Access descriptions remain
  truthful and route to the relevant settings instead of implying an unsaved
  security change.
- Responsive fit: Passed at the QA viewport with no clipping or overflow.
- Drawer hierarchy: Passed. The existing route and tunnel forms retain their
  original density and visual grammar, while the stable right-side drawer adds
  a clear title, Local Routes / Public Tunnel switch, backdrop, and sticky
  save controls.
- Focused comparison: No additional crop was needed for the drawer iteration
  because each 1440 × 1024 source and implementation panel remains readable in
  the paired full-view evidence. The smaller access segmented control still
  uses its dedicated focused comparison.

## Interaction Review

- Open/close popover: Passed.
- Copy and open destination actions: Present for each destination.
- Disconnect Quick Tunnel: Passed.
- Select Named while disconnected: Passed.
- Named setup deep-link to Config → Tunneling: Passed.
- Mode change while connected: Intentionally locked until disconnect, with
  explanatory copy, so the persisted mode cannot diverge from the running
  connector.
- Tunnel output defaults to collapsed: Passed.
- Expand/collapse tunnel output and empty-stream state: Passed.
- Tunnel output uses the existing live app/instance event stream and exposes a
  clear action when lines exist: Verified in code and production build.
- Password shortcut to Config → Domain: Passed.
- CF Access shortcut to Config → Tunneling: Passed.
- Manage Routes & Access opens the drawer on Local Routes: Passed.
- Local Routes / Public Tunnel switching: Passed.
- Named Tunnel deep-link opens the drawer directly on Public Tunnel: Passed.
- Config navigation contains no redundant Domain, Tunneling, or Routes & Access
  destination; the complete editor lives only in the popover drawer: Passed.
- Drawer focus moves to Close, Tab is contained within the dialog, Escape and
  backdrop dismissal are supported, and the app root is inert while open:
  Passed.
- Browser console checked. The browser-only preview still reports the existing
  Tauri event-bridge `transformCallback` rejection because no native runtime is
  attached.

## Comparison History

1. Initial browser-only state showed one local route and no established public
   route, which did not exercise the selected design.
2. Browser mock data was aligned with the target state: primary plus two local
   aliases and one connected Quick Tunnel URL.
3. The follow-up initially omitted the old Publish tab's access selector and
   live output stream. Those existing behaviors were moved into the new
   popover.
4. The final full-view and focused side-by-side comparisons found no actionable
   P0, P1, or P2 fidelity issues. The only P3 difference is slightly tighter
   panel density inside the real workbench shell.
5. Domain and Tunneling initially remained separate Config destinations after
   the popover redesign. Their production forms were moved into a shared
   Routes & Access drawer. A temporary combined Config entry was also removed
   so the editor now has one owner and one entry point.
6. The first drawer pass had `aria-modal` but did not isolate keyboard focus.
   The drawer was moved to a portal, the app root is made inert while open,
   focus starts on Close, and Tab/Escape behavior is contained. The final
   screenshots and interaction pass found no remaining P0, P1, or P2 issues.

## Runtime Notes

The browser-only preview logs the existing Tauri event bridge
`transformCallback` rejection because no native Tauri runtime is attached.
This does not affect the rendered access flow. Per project preference, Tauri
dev was not started.

## Final Result

final result: passed
