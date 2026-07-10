import { useEffect, useRef, useState } from "react";
import { parseFrontmatter, serializeFrontmatter } from "@kestravault/core";
import type { EffectivePrivacy, PrivacyMode } from "@kestravault/core";
import { Lock, LockOpen, SlidersHorizontal, CloudOff } from "lucide-react";

interface PropertiesProps {
  path: string;
  content: string;
  defaultTitle: string;
  /** Whether the active AI provider runs on-device — relaxes the Private rule. */
  aiIsLocal: boolean;
  privacy?: EffectivePrivacy;
  onSetPrivacy: (mode: PrivacyMode) => Promise<void>;
  onClearPrivacy: () => Promise<void>;
  onChange: (next: string) => void;
}

type Data = Record<string, unknown>;

function asObject(value: unknown): Data {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Data) : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

// Notion-style editable frontmatter shown above the editor. The raw YAML is
// hidden in the Live Preview (see livePreview.ts), so this is the UI for it.
export function Properties({
  path,
  content,
  defaultTitle,
  aiIsLocal,
  privacy,
  onSetPrivacy,
  onClearPrivacy,
  onChange,
}: PropertiesProps) {
  const contentRef = useRef(content);
  contentRef.current = content;
  const [newKey, setNewKey] = useState("");
  // Properties stay collapsed by default so the note head reads clean; the
  // hover-revealed toggle (next to "Make private") expands them on demand.
  const [showProps, setShowProps] = useState(false);
  // Re-collapse when switching notes so each one opens clean.
  useEffect(() => setShowProps(false), [path]);

  const hasFrontmatter = /^---\r?\n/.test(content);
  const { data } = parseFrontmatter(content);
  const obj = asObject(data);
  const effectiveMode: PrivacyMode =
    privacy?.mode ?? (obj.private === true ? "cloud-ai-private" : "public");
  // `private` gets its own switch (below) — keep it out of the generic field list.
  const entries = Object.entries(obj).filter(([key]) => key !== "private");

  // Re-parse at commit time so concurrent body edits aren't clobbered.
  function commit(mutate: (d: Data) => Data): void {
    const parsed = parseFrontmatter(contentRef.current);
    const nextData = mutate(asObject(parsed.data));
    onChange(serializeFrontmatter(nextData, parsed.body));
  }

  function setField(key: string, value: unknown): void {
    commit((d) => ({ ...d, [key]: value }));
  }

  function removeField(key: string): void {
    commit((d) => {
      const next = { ...d };
      delete next[key];
      return next;
    });
  }

  function addField(): void {
    const key = newKey.trim();
    if (!key || key in obj) return;
    setNewKey("");
    setField(key, "");
  }

  async function setPrivacyFromMenu(value: string): Promise<void> {
    if (value === "inherit") {
      await onClearPrivacy();
      return;
    }
    const mode = value as PrivacyMode;
    if (mode === "local-only") {
      if (
        !window.confirm(
          "Keep this note local only?\n\nExisting cloud copies will be removed for all synced devices and shared workspace members. The local file stays on this device.",
        )
      ) {
        return;
      }
    }
    await onSetPrivacy(mode);
  }

  const privacyLabel =
    effectiveMode === "local-only"
      ? "Local only"
      : effectiveMode === "cloud-ai-private"
        ? "AI private"
        : "Make private";

  const privatePill = (
    <label
      className={`props-add-fm props-private-pill props-privacy-select${
        effectiveMode !== "public" ? " is-on" : ""
      }`}
      title={
        aiIsLocal
          ? "AI is local — the body is never sent off-device"
          : effectiveMode === "local-only"
            ? "Local only: not synced to cloud and hidden from remote AI"
            : effectiveMode === "cloud-ai-private"
              ? "AI private: synced, but hidden from remote AI"
              : "Choose note privacy"
      }
    >
      <PrivacyIcon mode={effectiveMode} /> {privacyLabel}
      <select
        value={privacy?.explicit ? effectiveMode : effectiveMode === "public" ? "public" : "inherit"}
        onChange={(e) => void setPrivacyFromMenu(e.target.value)}
        aria-label="Note privacy"
      >
        <option value="public">Visible to cloud AI</option>
        <option value="cloud-ai-private">Sync to cloud, hide from AI</option>
        <option value="local-only">Keep local only</option>
        {privacy?.explicit || (!privacy?.explicit && effectiveMode !== "public") ? (
          <option value="inherit">Use inherited setting</option>
        ) : null}
      </select>
    </label>
  );

  // No frontmatter → keep the note clean. Both affordances stay hover-revealed.
  if (!hasFrontmatter) {
    return (
      <div className="props-empty">
        <button className="props-add-fm" onClick={() => commit(() => ({ title: defaultTitle }))}>
          ＋ Add properties
        </button>
        {privatePill}
      </div>
    );
  }

  // Collapsible disclosure for the frontmatter fields. The count keeps hidden
  // properties discoverable; expanding stays sticky so the row pills can fall
  // back to hover-only without yanking the open fields away.
  const propsToggle = (
    <button
      className={`props-add-fm props-toggle${showProps ? " is-on" : ""}`}
      onClick={() => setShowProps((v) => !v)}
      aria-pressed={showProps}
      aria-expanded={showProps}
      title={showProps ? "Hide properties" : "Show properties"}
    >
      <SlidersHorizontal size={13} strokeWidth={1.6} aria-hidden />{" "}
      {entries.length ? `Properties · ${entries.length}` : "Properties"}
    </button>
  );

  return (
    <div className={`props${showProps ? " is-open" : ""}`}>
      <div className="props-actions">
        {propsToggle}
        {privatePill}
      </div>
      {showProps &&
        entries.map(([key, value]) => (
        <div className="prop-row" key={`${path}:${key}`}>
          <span className="prop-key" title={key}>
            {key}
          </span>
          <div className="prop-value">
            {Array.isArray(value) ? (
              <TagList
                tags={asStringArray(value)}
                onAdd={(t) => setField(key, [...asStringArray(value), t])}
                onRemove={(i) => setField(key, asStringArray(value).filter((_, idx) => idx !== i))}
              />
            ) : typeof value === "boolean" ? (
              <input
                type="checkbox"
                checked={value}
                onChange={(e) => setField(key, e.target.checked)}
              />
            ) : (
              <input
                className="prop-input"
                defaultValue={value == null ? "" : String(value)}
                onBlur={(e) => {
                  if (e.target.value !== String(value ?? "")) setField(key, e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            )}
          </div>
          <button className="prop-remove" title="Remove property" onClick={() => removeField(key)}>
            ×
          </button>
        </div>
        ))}

      {showProps && (
        <div className="prop-add">
          <input
            className="prop-add-input"
            placeholder="Add property…"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addField();
            }}
          />
        </div>
      )}
    </div>
  );
}

function PrivacyIcon({ mode }: { mode: PrivacyMode }) {
  const Icon = mode === "local-only" ? CloudOff : mode === "cloud-ai-private" ? Lock : LockOpen;
  return <Icon size={13} strokeWidth={1.6} aria-hidden />;
}

function TagList({
  tags,
  onAdd,
  onRemove,
}: {
  tags: string[];
  onAdd: (tag: string) => void;
  onRemove: (index: number) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div className="tag-list">
      {tags.map((t, i) => (
        <span className="tag-chip" key={`${t}-${i}`}>
          {t}
          <button className="tag-x" onClick={() => onRemove(i)} title="Remove tag">
            ×
          </button>
        </span>
      ))}
      <input
        className="tag-input"
        placeholder="add tag"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draft.trim()) {
            onAdd(draft.trim());
            setDraft("");
          }
        }}
      />
    </div>
  );
}
