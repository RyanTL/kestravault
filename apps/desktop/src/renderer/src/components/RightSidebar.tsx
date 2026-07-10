import { Outline } from "@renderer/components/Outline";
import { Backlinks } from "@renderer/components/Backlinks";
import { Activity } from "@renderer/components/Activity";

interface RightSidebarProps {
  activePath: string | null;
  content: string;
  files: { name: string; path: string }[];
  onOpen: (path: string) => void;
  onJump: (line: number) => void;
}

// The right sidebar: the active note's heading Outline plus its Linked mentions
// (Obsidian's right-pane layout), and — when the vault is linked to a cloud
// workspace — the shared-vault Activity feed (presence + attributed changes).
// Toggled from the title bar / command palette.
export function RightSidebar({ activePath, content, files, onOpen, onJump }: RightSidebarProps) {
  return (
    <aside className="pane pane-right">
      <div className="side-scroll">
        {activePath ? (
          <>
            <div className="side-section">
              <div className="side-head">Outline</div>
              <Outline content={content} onJump={onJump} />
            </div>
            <Backlinks currentPath={activePath} files={files} onOpen={onOpen} />
          </>
        ) : (
          <div className="side-empty side-empty-pad">No note open.</div>
        )}
        <Activity onOpen={onOpen} />
      </div>
    </aside>
  );
}
