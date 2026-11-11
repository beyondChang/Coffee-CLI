// AgentAppsSection.tsx — the settings modal's 应用 section.
//
// It is the "应用配置" dialog, moved into the settings modal: the 常用 tab
// (pinned tools on the launchpad) plus the panels behind the other tabs —
// 主记忆, 多智能体编排, 技能, 电脑控制 and 浏览器控制. The cards reuse the
// dialog's format so both screens read alike, and both surfaces share one pin
// store, so a toggle here is already reflected on the launchpad behind the
// dialog.

import { useEffect, useState } from 'react';
import { CONFIGURABLE_AGENT_TOOLS, getToolIcon } from '../center/CenterPanel';
import { ToolConfigModal } from '../center/ToolConfigModal';
import { ToolSettingsPage } from '../center/ToolSettingsPage';
import { AGENT_APP_KEYS } from '../../lib/agent-apps';
import { PINNED_ITEMS_LIMIT, usePinnedItems } from '../../lib/pinned-tools';
import { getToolDisplayName } from '../../lib/tool-info';
import { commands, isTauri } from '../../tauri';
import { useT } from '../../i18n/useT';
import '../center/CenterPanel.css';
import '../center/ToolSettingsPage.css';
import './AgentAppsSection.css';

export function AgentAppsSection() {
  const t = useT();
  const [pinnedItems, togglePin] = usePinnedItems();
  const [configTool, setConfigTool] = useState<{ key: string; label: string } | null>(null);
  const [installed, setInstalled] = useState<Record<string, boolean>>({});

  // The panels behind the other tabs gate per-tool features on whether the
  // CLI is installed, so the same scan the launchpad uses is needed here.
  useEffect(() => {
    if (!isTauri) return;
    let active = true;
    try {
      commands.checkToolsInstalled()
        .then(result => { if (active) setInstalled(result); })
        .catch(() => {});
    } catch { /* A missing scan must not take the section down. */ }
    return () => { active = false; };
  }, []);

  // The settings dialog closes itself on Escape from a document listener, so
  // the per-tool overlay has to claim the key first and keep it from reaching
  // the dialog behind it.
  useEffect(() => {
    if (!configTool) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setConfigTool(null);
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [configTool]);

  const labelOf = (key: string) => key === 'terminal' ? t('tool.terminal') : getToolDisplayName(key);

  // Only ids the catalog still renders count toward N/6, so a retired pin in
  // storage cannot inflate the counter.
  const pinnedCount = AGENT_APP_KEYS.filter(key => pinnedItems.includes(`agent:${key}`)).length;

  // The tool list the panels work on: the pinned ones, like the dialog passes.
  const tools = AGENT_APP_KEYS
    .filter(key => pinnedItems.includes(`agent:${key}`))
    .map(key => ({ value: key, label: labelOf(key), icon: getToolIcon(key), installed: key === 'terminal' || installed[key] !== false }));

  const grid = <>
    {[true, false].map(enabled => {
      const keys = AGENT_APP_KEYS.filter(key => pinnedItems.includes(`agent:${key}`) === enabled);
      if (keys.length === 0) return null;
      return <div key={String(enabled)} className="settings-apps-group">
        {!enabled && pinnedCount > 0 && <hr className="library-divider" />}
        <div className="library-grid settings-apps-grid">
          {keys.map(key => {
            const pinId = `agent:${key}`;
            const label = labelOf(key);
            const hasGear = CONFIGURABLE_AGENT_TOOLS.has(key);
            return <div
              key={key}
              className={`library-item${enabled ? ' is-pinned' : ''}`}
              role="button"
              tabIndex={0}
              aria-pressed={enabled}
              aria-label={label}
              onClick={() => togglePin(pinId)}
              onKeyDown={event => {
                if (event.target !== event.currentTarget) return;
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                togglePin(pinId);
              }}
            >
              <div className="library-item-icon">{getToolIcon(key)}</div>
              <span className="library-item-name">{label}</span>
              {hasGear && <button
                type="button"
                className="library-gear-btn"
                aria-label={t('settings.apps.configure', { tool: label })}
                onClick={event => { event.stopPropagation(); setConfigTool({ key, label }); }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>}
              <div className={`library-toggle${enabled ? ' on' : ''}`} aria-hidden="true"><div className="library-toggle-knob" /></div>
            </div>;
          })}
        </div>
      </div>;
    })}
  </>;

  return <section className="settings-apps">
    {/* No heading of its own: the rail already says 应用 and the 常用 tab
        carries the N/6 count, so the section opens straight on the tabs. */}
    {/* The tool dialog's own page: the 常用 cards above, the panels behind
        the other tabs (主记忆 / 多智能体编排 / 技能 / 电脑控制 / 浏览器控制). */}
    <ToolSettingsPage active tools={tools} count={pinnedCount} limit={PINNED_ITEMS_LIMIT}>
      {grid}
    </ToolSettingsPage>
    {/* The config modal mounts itself at body level (see ToolConfigModal) so
        it stacks above this section's dialog. */}
    {configTool && <ToolConfigModal toolKey={configTool.key} toolLabel={configTool.label} onClose={() => setConfigTool(null)} />}
  </section>;
}
