/**
 * AiAssistantPanel.tsx
 * ------------------------------------------------------------------
 * Helmsman — 遊戲頁的 AI 診斷面板（Phase 4 唯讀切片）。
 *
 * 只送 { appName, runner }；context + log 由後端權威組（window.api.helmsmanDiagnose）。
 * 唯讀：顯示判定（verdict）+ 偵測到的問題（signals，含命中 log 行）+ 建議修正（唯讀，
 * 一鍵套用待 Phase 5 的可信確認回路）。不接 LLM 對話（aiAdvisor 待後）。
 */

import './AiAssistantPanel.css'

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { TFunction } from 'i18next'
import type { Runner } from 'common/types'
import type { DiagnoseResult } from 'backend/ai/orchestrator'
import type {
  Backend,
  DetectedSignal,
  RecommendedAction,
  Severity,
  Verdict
} from 'backend/ai/types'

interface AiAssistantPanelProps {
  appName: string
  runner: Runner
}

export default function AiAssistantPanel({
  appName,
  runner
}: AiAssistantPanelProps) {
  const { t } = useTranslation('gamepage')
  const [result, setResult] = useState<DiagnoseResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const runDiagnosis = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await window.api.helmsmanDiagnose({ appName, runner })
      if ('error' in res) {
        setError(res.error)
        setResult(null)
      } else {
        setResult(res)
      }
    } catch (e) {
      setError(
        e instanceof Error ? e.message : t('game.ai.failed', 'Diagnosis failed')
      )
    } finally {
      setLoading(false)
    }
  }, [appName, runner, t])

  const hasSignals = (result?.analysis.signals.length ?? 0) > 0

  return (
    <div className="aiPanel">
      <div className="aiPanelHeader">
        <span className="aiPanelTitle">
          {t('game.ai.title', 'AI Diagnostics')}
        </span>
        <button
          type="button"
          className="button is-primary"
          onClick={runDiagnosis}
          disabled={loading}
        >
          {loading
            ? t('game.ai.diagnosing', 'Diagnosing…')
            : result
              ? t('game.ai.rediagnose', 'Re-run diagnosis')
              : t('game.ai.diagnose', 'Diagnose')}
        </button>
      </div>

      {error && (
        <p className="aiPanelError" role="alert">
          {error}
        </p>
      )}

      {!result && !loading && !error && (
        <p className="aiPanelHint">
          {t(
            'game.ai.empty',
            "Game won't start? Run a diagnosis — Helmsman reads the game's log and suggests fixes."
          )}
        </p>
      )}

      {result && (
        <>
          <VerdictBanner verdict={result.recommendation.verdict} t={t} />
          {hasSignals ? (
            <>
              <Signals signals={result.analysis.signals} t={t} />
              <Recommendations actions={result.recommendation.actions} t={t} />
            </>
          ) : (
            <p className="aiPanelHint">
              {t(
                'game.ai.no-issues',
                'No known issues detected. Diagnosis reads the game log — if it actually fails to launch, run it once so Heroic produces a log, then diagnose again.'
              )}
            </p>
          )}
        </>
      )}
    </div>
  )
}

// ── 子元件（模組層，避免 nested-component 重建）──────────────────────

function VerdictBanner({ verdict, t }: { verdict: Verdict; t: TFunction }) {
  const meta = verdictMeta(verdict, t)
  return (
    <div className="aiPanelVerdict" data-tone={meta.tone}>
      {meta.label}
    </div>
  )
}

function Signals({ signals, t }: { signals: DetectedSignal[]; t: TFunction }) {
  return (
    <div className="aiPanelSection">
      <p className="aiPanelSectionTitle">
        {t('game.ai.signals', 'Detected issues')}
      </p>
      {signals.map((sig) => (
        <div key={sig.id} className="aiPanelSignal">
          <div className="aiPanelSignalHead">
            <span className="aiPanelBadge" data-severity={sig.severity}>
              {severityLabel(sig.severity, t)}
            </span>
            <span className="aiPanelSignalMsg">{sig.message}</span>
            <span className="aiPanelSignalSrc">{sig.layer}</span>
          </div>
          {/* 命中的第一行 log，讓判定可追溯（透明化，非黑盒）。 */}
          {sig.evidence[0] && (
            <code className="aiPanelEvidence">{sig.evidence[0]}</code>
          )}
        </div>
      ))}
    </div>
  )
}

function Recommendations({
  actions,
  t
}: {
  actions: RecommendedAction[]
  t: TFunction
}) {
  if (actions.length === 0) return null
  return (
    <div className="aiPanelSection">
      <p className="aiPanelSectionTitle">
        {t('game.ai.recommendations', 'Suggested fixes')}
      </p>
      {actions.map((act, i) => (
        <div key={i} className="aiPanelAction">
          {act.kind !== 'none' && (
            <p className="aiPanelActionTitle">{actionTitle(act, t)}</p>
          )}
          <p className="aiPanelActionReason">
            {act.reason}
            {act.kind !== 'none' &&
              ` · ${t('game.ai.confidence', 'confidence')} ${act.confidence.toFixed(1)}`}
          </p>
        </div>
      ))}
      <p className="aiPanelNote">
        {t(
          'game.ai.apply-soon',
          'One-click apply is coming soon — these are read-only suggestions for now.'
        )}
      </p>
    </div>
  )
}

// ── 純工具（verdict / severity / action 顯示文案）─────────────────────

function verdictMeta(
  v: Verdict,
  t: TFunction
): { label: string; tone: 'ok' | 'warn' | 'danger' } {
  switch (v) {
    case 'launched_ok':
      return { label: t('game.ai.verdict.ok', 'Looks fine'), tone: 'ok' }
    case 'recoverable':
      return {
        label: t('game.ai.verdict.recoverable', 'Fixable'),
        tone: 'warn'
      }
    case 'needs_backend_change':
      return {
        label: t('game.ai.verdict.backend', 'Needs a different backend'),
        tone: 'warn'
      }
    case 'incompatible':
      return {
        label: t('game.ai.verdict.incompatible', "Can't run"),
        tone: 'danger'
      }
    default:
      return {
        label: t('game.ai.verdict.unknown', 'Inconclusive'),
        tone: 'warn'
      }
  }
}

function severityLabel(s: Severity, t: TFunction): string {
  switch (s) {
    case 'fatal':
      return t('game.ai.sev.fatal', 'Fatal')
    case 'error':
      return t('game.ai.sev.error', 'Error')
    case 'warning':
      return t('game.ai.sev.warning', 'Warning')
    default:
      return t('game.ai.sev.info', 'Info')
  }
}

function actionTitle(act: RecommendedAction, t: TFunction): string {
  switch (act.kind) {
    case 'switch_backend':
      return t('game.ai.act.switch', 'Switch backend to {{backend}}', {
        backend: formatBackend(act.params.backend as Backend)
      })
    case 'install_winetricks':
      return t('game.ai.act.winetricks', 'Install {{verb}}', {
        verb:
          typeof act.params.verb === 'string' ? act.params.verb : 'dependency'
      })
    case 'install_dxvk':
      return t('game.ai.act.dxvk', 'Install / update DXVK')
    case 'reinstall_wine_variant':
      return t('game.ai.act.wine', 'Reinstall Wine variant')
    case 'install_steam':
      return t('game.ai.act.steam', 'Install a second Steam')
    case 'change_setting':
      return t('game.ai.act.setting', 'Adjust setting {{name}}', {
        name: typeof act.params.key === 'string' ? act.params.key : ''
      })
    default:
      return ''
  }
}

function formatBackend(b: Backend): string {
  const map: Record<Backend, string> = {
    wined3d: 'Wined3d',
    dxvk: 'DXVK-macOS',
    dxmt: 'DXMT',
    gptk: 'GPTK',
    crossover: 'CrossOver'
  }
  return map[b] ?? b
}
