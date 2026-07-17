import { useState } from "react";
import { Button, Input, Select, Field, Card, Modal, Tabs, StatusDot, Badge, Popover, ListRow, EmptyState, Skeleton } from ".";
import type { Status } from ".";

// Dev-only component to eyeball every primitive against the tokens.
// Reach it via the URL hash `#gallery` (wired in App.tsx).
export default function UiGallery() {
  const [tab, setTab] = useState("changes");
  const [modal, setModal] = useState(false);
  const [pop, setPop] = useState(false);
  const statuses: Status[] = ["running", "stopped", "error", "update", "connecting"];

  return (
    <div className="p-8 space-y-6 max-w-3xl">
      <h1 className="text-[18px] font-medium text-ink">UI primitives</h1>

      <section className="space-y-2">
        <div className="text-[11px] uppercase tracking-wide text-ink-3">Buttons</div>
        <div className="flex flex-wrap gap-2 items-center">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button size="sm" variant="primary">Small</Button>
          <Button disabled>Disabled</Button>
        </div>
      </section>

      <section className="space-y-2">
        <div className="text-[11px] uppercase tracking-wide text-ink-3">Inputs</div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Name"><Input placeholder="prod-web" /></Field>
          <Field label="Auth"><Select><option>SSH agent</option><option>Key file</option></Select></Field>
          <Field label="Port"><Input defaultValue="22" /></Field>
        </div>
      </section>

      <section className="space-y-2">
        <div className="text-[11px] uppercase tracking-wide text-ink-3">Status &amp; badges</div>
        <div className="flex flex-wrap gap-4 items-center">
          {statuses.map((s) => (
            <span key={s} className="flex items-center gap-1.5 text-[12px] text-ink-2"><StatusDot status={s} />{s}</span>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone="neutral">neutral</Badge>
          <Badge tone="accent">accent</Badge>
          <Badge tone="ok">running</Badge>
          <Badge tone="warn">2↑ update</Badge>
          <Badge tone="bad">error</Badge>
        </div>
      </section>

      <section className="space-y-2">
        <div className="text-[11px] uppercase tracking-wide text-ink-3">Card · Tabs · List</div>
        <Card>
          <Tabs
            tabs={[{ id: "changes", label: "Changes", badge: <Badge tone="neutral">3</Badge> }, { id: "history", label: "History" }, { id: "branches", label: "Branches" }]}
            active={tab}
            onSelect={setTab}
          />
          <div className="mt-2 flex flex-col gap-0.5">
            <ListRow active leading={<StatusDot status="running" />} trailing={<span className="text-[10px] text-ink-3">:3000</span>}>frontend</ListRow>
            <ListRow leading={<StatusDot status="stopped" />}>api</ListRow>
          </div>
        </Card>
      </section>

      <section className="space-y-2">
        <div className="text-[11px] uppercase tracking-wide text-ink-3">Overlays &amp; feedback</div>
        <div className="flex gap-3 items-start">
          <Button variant="primary" onClick={() => setModal(true)}>Open modal</Button>
          <Popover
            open={pop}
            onClose={() => setPop(false)}
            anchor={<Button onClick={() => setPop((v) => !v)}>Popover</Button>}
          >
            <ListRow>All workspaces</ListRow>
            <ListRow active>Mediapress</ListRow>
          </Popover>
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-2.5 w-3/4" />
            <Skeleton className="h-2.5 w-full" />
            <Skeleton className="h-2.5 w-1/2" />
          </div>
        </div>
      </section>

      <Card padded={false} className="overflow-hidden">
        <EmptyState title="No hosts yet" hint="Add your first SSH host to get started." action={<Button variant="primary">Add host</Button>} />
      </Card>

      {modal && (
        <Modal
          onClose={() => setModal(false)}
          title="Add host"
          footer={<><Button onClick={() => setModal(false)}>Cancel</Button><Button variant="primary" onClick={() => setModal(false)}>Save</Button></>}
        >
          <Field label="Label"><Input placeholder="prod-web" /></Field>
          <Field label="Hostname"><Input placeholder="1.2.3.4" /></Field>
        </Modal>
      )}
    </div>
  );
}
