import { useCallback, useEffect, useState } from "react";
import type {
  AgentChangeSetSummary,
  FeedEntry,
  PresenceEntry,
  SyncStatusInfo,
} from "@renderer/env";
import { noteName } from "@renderer/vault/paths";

interface ActivityProps {
  onOpen: (path: string) => void;
}

/** "2m ago" / "3h ago" / "yesterday" — coarse on purpose (it's a feed, not a log). */
function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** "alice@example.com" -> "alice" (the feed is tight on width). */
function shortName(email: string | null): string {
  if (!email) return "agent";
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : email;
}

// The vault Activity panel (shared workspaces): who's here right now, and the
// attributed change feed — every synced edit, by author, newest first
// (plan/sync-collab-open-core.md §2). Renders nothing when the vault isn't
// linked to a cloud workspace, so solo/local vaults never see it.
export function Activity({ onOpen }: ActivityProps) {
  const [linked, setLinked] = useState(false);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [changeSets, setChangeSets] = useState<AgentChangeSetSummary[]>([]);
  const [presence, setPresence] = useState<PresenceEntry[]>([]);
  const [reverting, setReverting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const status = await window.api.sync.status();
      const isLinked = !!status.workspaceId && status.signedIn;
      setLinked(isLinked);
      if (isLinked) {
        const [nextChangeSets, nextFeed] = await Promise.all([
          window.api.collab.changeSets(8),
          window.api.collab.feed(30),
        ]);
        setChangeSets(nextChangeSets);
        setFeed(nextFeed);
      } else {
        setChangeSets([]);
        setFeed([]);
      }
    } catch {
      setLinked(false);
      setChangeSets([]);
      setFeed([]);
    }
  }, []);

  const onRevert = useCallback(
    async (changeSet: AgentChangeSetSummary): Promise<void> => {
      if (changeSet.reverted || reverting) return;
      if (!window.confirm(`Revert "${changeSet.summary || changeSet.kind}"?`)) return;
      setReverting(changeSet.id);
      setError(null);
      try {
        await window.api.collab.revertChangeSet(changeSet.id);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Revert failed.");
      } finally {
        setReverting(null);
      }
    },
    [refresh, reverting],
  );

  useEffect(() => {
    void refresh();
    // A finished sync run is exactly when the feed may have new rows.
    const offStatus = window.api.sync.onStatus((status: SyncStatusInfo) => {
      if (!status.syncing) void refresh();
    });
    const offPresence = window.api.collab.onPresence(setPresence);
    return () => {
      offStatus();
      offPresence();
    };
  }, [refresh]);

  if (!linked) return null;

  const others = presence.filter((p) => !p.isSelf);

  return (
    <div className="side-section">
      <div className="side-head">Activity</div>
      {others.length > 0 ? (
        <div className="activity-presence">
          {others.map((p) => (
            <div className="activity-presence-row" key={p.userId}>
              <span className="activity-dot" aria-hidden="true" />
              <span className="activity-presence-text">
                {shortName(p.email)}
                {p.notePath ? (
                  <>
                    {" — editing "}
                    <button className="activity-link" onClick={() => onOpen(p.notePath as string)}>
                      {p.noteTitle ?? noteName(p.notePath)}
                    </button>
                  </>
                ) : (
                  " — online"
                )}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {changeSets.length > 0 ? (
        <div className="activity-changes">
          <div className="activity-subhead">Agent changes</div>
          {error ? <div className="activity-error">{error}</div> : null}
          {changeSets.map((cs) => (
            <div className="activity-change" key={cs.id} title={cs.paths.join(", ")}>
              <div className="activity-change-main">
                <span className="activity-item-title">{cs.summary || cs.kind}</span>
                <span className="activity-item-meta">
                  {cs.fileCount} file{cs.fileCount === 1 ? "" : "s"} · {timeAgo(cs.createdAt)}
                  {cs.reverted ? " · reverted" : ""}
                </span>
              </div>
              <button
                className="activity-revert"
                disabled={cs.reverted || reverting !== null}
                onClick={() => void onRevert(cs)}
              >
                {reverting === cs.id ? "…" : "Revert"}
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {feed.length === 0 ? (
        <div className="side-empty">No synced changes yet.</div>
      ) : (
        <div className="activity-feed">
          {feed.map((e) => (
            <button
              className="activity-item"
              key={e.versionId}
              onClick={() => !e.deleted && onOpen(e.path)}
              disabled={e.deleted}
              title={`${e.path} · v${e.version}`}
            >
              <span className="activity-item-title">
                {e.title || noteName(e.path)}
                {e.deleted ? " (deleted)" : ""}
              </span>
              <span className="activity-item-meta">
                {e.isSelf ? "you" : shortName(e.authorEmail)} · {timeAgo(e.createdAt)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
