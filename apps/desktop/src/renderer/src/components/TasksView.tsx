import { SquareCheckBig, X } from "lucide-react";

// Placeholder for the upcoming task-management feature: the sidebar's "My
// Tasks" entry opens this in the main area (where the editor normally sits),
// mirroring how Notion opens My Tasks as a page. For now it only sets the
// expectation — no tasks are collected yet.
export function TasksView({ onClose }: { onClose: () => void }) {
  return (
    <section className="tasks-view" aria-label="My Tasks">
      <header className="tasks-view-header">
        <span className="tasks-view-title">My Tasks</span>
        <button className="icon-btn" title="Close" aria-label="Close My Tasks" onClick={onClose}>
          <X size={15} strokeWidth={1.8} aria-hidden />
        </button>
      </header>
      <div className="tasks-empty">
        <span className="tasks-empty-icon" aria-hidden>
          <SquareCheckBig size={26} strokeWidth={1.5} />
        </span>
        <h2 className="tasks-empty-title">Nothing here yet</h2>
        <p className="tasks-empty-text">
          To-dos from across your notes will gather here, so you can plan your day without leaving
          your vault.
        </p>
        <span className="tasks-empty-badge">Coming soon</span>
      </div>
    </section>
  );
}
