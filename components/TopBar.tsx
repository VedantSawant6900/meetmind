"use client";

type TopBarProps = {
  exportDisabled: boolean;
  onExport: () => void;
  onOpenSettings: () => void;
};

export function TopBar({ exportDisabled, onExport, onOpenSettings }: TopBarProps) {
  return (
    <div className="topbar">
      <h1>MeetMind — Live Suggestions</h1>
      <div className="topbar-actions">
        <div className="meta">3-column layout · Transcript · Live Suggestions · Chat</div>
        <button className="settings-btn" disabled={exportDisabled} onClick={onExport} type="button">
          Export
        </button>
        <button className="settings-btn" onClick={onOpenSettings} type="button">
          Settings
        </button>
      </div>
    </div>
  );
}
