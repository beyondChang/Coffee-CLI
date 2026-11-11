import { useEffect, useRef, useState, type ReactNode } from 'react';
import { commands, type EgoAgentState, type EgoStatus } from '../../tauri';
import { useT } from '../../i18n/useT';
import type { I18nKey } from '../../i18n/en';
import './ToolControlPanel.css';

const errors: Record<string, I18nKey> = {
  ego_read: 'control.ego.read_error',
  ego_write: 'control.ego.write_error',
  ego_missing: 'control.ego.missing',
  ego_conflict: 'control.ego.conflict',
  ego_unsupported: 'control.ego.not_supported',
};

const skillLabel: Record<string, I18nKey> = {
  installed: 'control.ego.skill_installed',
  managed: 'control.ego.skill_managed',
  missing: 'control.ego.skill_missing',
  modified: 'control.ego.skill_modified',
  foreign: 'control.ego.skill_foreign',
  unsupported: 'control.ego.skill_unsupported',
  unknown: 'control.ego.unknown',
};

const permissionLabel: Record<string, I18nKey> = {
  allowed: 'control.ego.permission_allowed',
  prompt: 'control.ego.permission_prompt',
  unsupported: 'control.ego.permission_unsupported',
  unknown: 'control.ego.unknown',
};

function ready(agent: EgoAgentState | undefined) {
  return agent?.skill === 'installed' || agent?.skill === 'managed';
}

export function ToolEgoPanel({ active, tools }: {
  active: boolean; tools: { value: string; label: string; icon: ReactNode; installed?: boolean }[];
}) {
  const t = useT();
  const [status, setStatus] = useState<EgoStatus>();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<I18nKey>();
  const revision = useRef(0);
  const busy = pending !== null;

  useEffect(() => {
    if (!active) return;
    const version = ++revision.current;
    void commands.getEgoStatus()
      .then(value => { if (version === revision.current) { setStatus(value); setError(undefined); } })
      .catch(reason => { if (version === revision.current) setError(errors[String(reason)] ?? 'control.ego.read_error'); });
  }, [active]);

  const run = async (target: string, action: () => Promise<EgoStatus>) => {
    if (busy) return;
    revision.current++;
    setPending(target); setError(undefined);
    try {
      const value = await action();
      revision.current++;
      setStatus(value);
    } catch (reason) {
      revision.current++;
      setError(errors[String(reason)] ?? 'control.ego.write_error');
    } finally {
      setPending(null);
    }
  };

  // The cards come from the pinned agent list, so the panel keeps its shape
  // before the first status arrives instead of jumping into place.
  const rows = tools.slice(0, 6).map(tool => ({ tool, agent: status?.agents.find(agent => agent.tool === tool.value) }));
  const allowance = rows.find(row => row.agent && row.agent.permission !== 'unsupported');
  const allowanceOn = allowance?.agent?.permission === 'allowed';

  const toggle = (agent: EgoAgentState | undefined, tool: string) => {
    if (!agent) return;
    const on = !ready(agent) || !agent.instruction;
    if (on) {
      void run(tool, async () => {
        // The Skill may already be linked by the ego lite installer; the
        // install call reports that as done and leaves the link alone.
        const installed = await commands.installEgoSkill(tool);
        return agent.instructionSupported
          ? commands.setEgoInstruction(tool, true)
          : installed;
      });
    } else {
      void run(tool, async () => {
        const cleared = agent.instructionSupported
          ? await commands.setEgoInstruction(tool, false)
          : status!;
        return agent.skill === 'installed' ? await commands.removeEgoSkill(tool) : cleared;
      });
    }
  };

  return <div className="tool-control" aria-busy={busy || (!status && !error)}>
    <div className="tool-control-runtime">
      <span className="tool-control-symbol" aria-hidden="true">
        <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="16" cy="16" r="12" /><ellipse cx="16" cy="16" rx="5" ry="12" /><path d="M4 16h24M6 10h20M6 22h20" /></svg>
      </span>
      <div className="tool-control-summary">
        <strong>ego lite</strong>
        <p>{t('control.ego.description')}</p>
      </div>
      <span className={`tool-control-state${status?.installed ? ' is-ready' : ''}`} role="status">
        {!status ? '' : !status.supported ? t('control.ego.unsupported')
          : status.installed ? `${t('control.ego.installed')}${status.version ? ` ${status.version}` : ''}`
            : t('control.ego.not_installed')}
      </span>
      <button type="button" className="tool-memory-button tool-control-action" aria-label={t('control.check')} aria-busy={pending === 'runtime'} disabled={busy || !status?.supported} onClick={() => { void run('runtime', commands.getEgoStatus); }}>
        <span style={pending === 'runtime' ? { visibility: 'hidden' } : undefined}>{t('control.check')}</span>
        {pending === 'runtime' && <span className="tool-control-spinner" aria-hidden="true" />}
      </button>
      <button type="button" className="tool-memory-button tool-control-action tool-memory-save" aria-label={t('control.ego.install_all')} aria-busy={pending === 'install'} disabled={busy || !status?.installed} onClick={() => { void run('install', () => commands.installEgoSkill()); }}>
        <span style={pending === 'install' ? { visibility: 'hidden' } : undefined}>{t('control.ego.install_all')}</span>
        {pending === 'install' && <span className="tool-control-spinner" aria-hidden="true" />}
      </button>
    </div>
    {error && <p className="tool-memory-notice" role="alert">{t(error)}</p>}
    {status && status.legacy.length > 0 && <p className="tool-memory-notice" role="status">
      {t('control.ego.legacy', { count: status.legacy.length })}
      <button type="button" className="tool-memory-button" disabled={busy} onClick={() => { void run('legacy', commands.cleanupLegacyBrowser); }}>{t('control.ego.cleanup')}</button>
    </p>}
    <div className="ego-permission">
      <span className="ego-permission-label">{t('control.ego.allow_command')}</span>
      <button type="button" role="switch" aria-label={t('control.ego.allow_command')} aria-checked={allowanceOn} aria-busy={pending === 'permission'} className="tool-control-switch" disabled={busy || !allowance} onClick={() => {
        if (!allowance?.agent) return;
        void run('permission', () => commands.setEgoPermission(allowance.tool.value, !allowanceOn));
      }}><span /></button>
    </div>
    <div className="tool-control-agents">
      {rows.map(({ tool, agent }) => {
        const skill = agent?.skill ?? 'unknown';
        const instruction = !agent ? 'unknown' : agent.instruction ? 'on' : agent.instructionSupported ? 'off' : 'unsupported';
        const permission = agent?.permission ?? 'unknown';
        const on = ready(agent) && !!agent?.instruction;
        const unavailable = !!status && (!status.installed || agent?.supported === false);
        const modified = skill === 'modified' || skill === 'foreign';
        return <div className="tool-control-agent" key={tool.value}>
          <span className="tool-control-agent-icon" aria-hidden="true">{tool.icon}</span>
          <span className="tool-control-agent-name">
            <span className="tool-control-agent-label">{tool.label}</span>
            <span className="ego-state-tags">
              <span className="ego-state-tag" data-state={skill}>{t(skillLabel[skill] ?? 'control.ego.unknown')}</span>
              <span className="ego-state-tag" data-state={instruction}>{t(instruction === 'on' ? 'control.ego.instruction_on' : instruction === 'off' ? 'control.ego.instruction_off' : instruction === 'unsupported' ? 'control.ego.instruction_unsupported' : 'control.ego.unknown')}</span>
              <span className="ego-state-tag" data-state={permission}>{t(permissionLabel[permission] ?? 'control.ego.unknown')}</span>
            </span>
          </span>
          {pending === tool.value && <span className="tool-control-spinner" aria-hidden="true" />}
          <button type="button" role="switch" aria-label={tool.label} aria-checked={on} aria-busy={pending === tool.value} data-unavailable={unavailable || modified} className="tool-control-switch tool-control-card-toggle" disabled={busy || !status || unavailable || modified} onClick={() => toggle(agent, tool.value)}><span /></button>
        </div>;
      })}
      {!rows.length && <span className="tool-control-no-agents">{t('control.no_agents')}</span>}
    </div>
  </div>;
}
