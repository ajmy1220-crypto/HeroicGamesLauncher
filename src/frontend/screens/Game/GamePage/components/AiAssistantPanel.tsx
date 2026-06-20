/**
 * AiAssistantPanel.tsx
 * ------------------------------------------------------------------
 * Helmsman — 遊戲頁的 AI 診斷面板。
 *
 * 只送 { appName, runner }；context + log 由後端權威組（window.api.helmsmanDiagnose）。
 * 顯示判定（verdict）+ 偵測到的問題（signals，含命中 log 行）+ 建議修正。
 * 建議可【套用】（helmsmanApplyAction）：須確認的動作由後端彈【原生確認框】（§12.9 主程序
 * 權威，renderer 無法偽造）；install_winetricks 白名單免確認。
 * 規則層之外另有【Ask AI】（helmsmanAdvise）：模糊→AI 層，給 LLM 的人話解釋 + 建議（同走
 * 確認閘套用路徑）；未設 ANTHROPIC_API_KEY 時後端回 error，按鈕仍在但顯示「未設定」。
 */

import './AiAssistantPanel.css'

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { TFunction } from 'i18next'
import type { Runner } from 'common/types'
import type { DiagnoseResult, HelmsmanError } from 'backend/ai/orchestrator'
import type { AdvisorResult } from 'backend/ai/aiAdvisor'
import type { ExecutionResult } from 'backend/ai/actionExecutor'
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

type ApplyOutcome = { tone: 'ok' | 'warn' | 'err'; text: string }

export default function AiAssistantPanel({
  appName,
  runner
}: AiAssistantPanelProps) {
  const { t } = useTranslation('gamepage')
  const [result, setResult] = useState<DiagnoseResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // apply 並發鎖：非 null = 正在套用第 N 個建議；期間全部 apply / diagnose 按鈕 disabled。
  const [applyingIndex, setApplyingIndex] = useState<number | null>(null)
  const [applyResults, setApplyResults] = useState<
    Record<number, ApplyOutcome>
  >({})
  // LLM 模糊判斷（helmsmanAdvise）：規則層之外的人話解釋 + AI 建議。
  const [advice, setAdvice] = useState<AdvisorResult | null>(null)
  const [advising, setAdvising] = useState(false)
  const [adviceError, setAdviceError] = useState<string | null>(null)

  const runDiagnosis = useCallback(async () => {
    setLoading(true)
    setError(null)
    setApplyResults({})
    // 重診 → 舊 AI 建議與套用結果都過時，清掉。
    setAdvice(null)
    setAdviceError(null)
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

  const applyAction = useCallback(
    async (action: RecommendedAction, index: number) => {
      setApplyingIndex(index)
      try {
        const res = await window.api.helmsmanApplyAction({
          appName,
          runner,
          action
        })
        setApplyResults((prev) => ({ ...prev, [index]: describeApply(res, t) }))
      } catch (e) {
        setApplyResults((prev) => ({
          ...prev,
          [index]: {
            tone: 'err',
            text:
              e instanceof Error
                ? e.message
                : t('game.ai.apply.failed', 'Apply failed')
          }
        }))
      } finally {
        setApplyingIndex(null)
      }
    },
    [appName, runner, t]
  )

  const askAi = useCallback(async () => {
    setAdvising(true)
    setAdviceError(null)
    try {
      const res = await window.api.helmsmanAdvise({ appName, runner })
      if ('error' in res) {
        setAdviceError(res.error)
        setAdvice(null)
      } else {
        setAdvice(res)
      }
    } catch (e) {
      setAdviceError(
        e instanceof Error
          ? e.message
          : t('game.ai.advise.failed', 'AI request failed')
      )
    } finally {
      setAdvising(false)
    }
  }, [appName, runner, t])

  const busy = loading || advising || applyingIndex !== null
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
          disabled={busy}
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
              <Recommendations
                actions={result.recommendation.actions}
                applyingIndex={applyingIndex}
                applyResults={applyResults}
                onApply={applyAction}
                t={t}
              />
            </>
          ) : (
            <p className="aiPanelHint">
              {t(
                'game.ai.no-issues',
                'No known issues detected. Diagnosis reads the game log — if it actually fails to launch, run it once so Heroic produces a log, then diagnose again.'
              )}
            </p>
          )}
          <AiAdvice
            advice={advice}
            advising={advising}
            adviceError={adviceError}
            onAsk={askAi}
            busy={busy}
            applyingIndex={applyingIndex}
            applyResults={applyResults}
            onApply={applyAction}
            t={t}
          />
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
  applyingIndex,
  applyResults,
  onApply,
  t,
  indexOffset = 0
}: {
  actions: RecommendedAction[]
  applyingIndex: number | null
  applyResults: Record<number, ApplyOutcome>
  onApply: (action: RecommendedAction, index: number) => void
  t: TFunction
  /** apply 狀態的索引偏移：規則建議用 0、AI 建議用 AI_INDEX_OFFSET，避免兩組索引相撞。 */
  indexOffset?: number
}) {
  if (actions.length === 0) return null
  return (
    <div className="aiPanelSection">
      <p className="aiPanelSectionTitle">
        {t('game.ai.recommendations', 'Suggested fixes')}
      </p>
      {actions.map((act, i) => {
        const index = i + indexOffset
        const outcome = applyResults[index]
        return (
          <div key={index} className="aiPanelAction">
            <div className="aiPanelActionBody">
              {act.kind !== 'none' && (
                <p className="aiPanelActionTitle">{actionTitle(act, t)}</p>
              )}
              <p className="aiPanelActionReason">
                {act.reason}
                {act.kind !== 'none' &&
                  ` · ${t('game.ai.confidence', 'confidence')} ${act.confidence.toFixed(1)}`}
              </p>
              {outcome && (
                <p className="aiPanelApplyResult" data-tone={outcome.tone}>
                  {outcome.text}
                </p>
              )}
            </div>
            {isApplyable(act.kind) && (
              <button
                type="button"
                className="button is-primary aiPanelApplyBtn"
                onClick={() => onApply(act, index)}
                disabled={applyingIndex !== null}
              >
                {applyingIndex === index
                  ? t('game.ai.apply.applying', 'Applying…')
                  : t('game.ai.apply.btn', 'Apply')}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

// AI 建議的 apply 索引偏移（規則建議用 0..N，AI 用 1000+i，兩組共用 applyResults/applyingIndex 不撞）。
const AI_INDEX_OFFSET = 1000

function AiAdvice({
  advice,
  advising,
  adviceError,
  onAsk,
  busy,
  applyingIndex,
  applyResults,
  onApply,
  t
}: {
  advice: AdvisorResult | null
  advising: boolean
  adviceError: string | null
  onAsk: () => void
  busy: boolean
  applyingIndex: number | null
  applyResults: Record<number, ApplyOutcome>
  onApply: (action: RecommendedAction, index: number) => void
  t: TFunction
}) {
  return (
    <div className="aiPanelSection">
      <div className="aiPanelAdviseHead">
        <p className="aiPanelSectionTitle">
          {t('game.ai.advise.title', 'Ask AI')}
        </p>
        <button
          type="button"
          className="button is-primary aiPanelApplyBtn"
          onClick={onAsk}
          disabled={busy}
        >
          {advising
            ? t('game.ai.advise.asking', 'Asking AI…')
            : advice
              ? t('game.ai.advise.again', 'Ask again')
              : t('game.ai.advise.btn', 'Ask AI')}
        </button>
      </div>
      {adviceError && (
        <p className="aiPanelApplyResult" data-tone="err">
          {adviceError}
        </p>
      )}
      {advice && (
        <>
          <p className="aiPanelAdviceText">{advice.explanation}</p>
          <Recommendations
            actions={advice.suggestedActions}
            indexOffset={AI_INDEX_OFFSET}
            applyingIndex={applyingIndex}
            applyResults={applyResults}
            onApply={onApply}
            t={t}
          />
          <p className="aiPanelHint">
            {t(
              'game.ai.advise.disclaimer',
              'AI suggestions — review before applying.'
            )}
            {` · ${advice.provider}`}
          </p>
        </>
      )}
    </div>
  )
}

// ── 純工具 ──────────────────────────────────────────────────────────

/**
 * 哪些 kind 出 apply 按鈕。install_steam 不出（bridge 的 STEAM_SETUP_EXE 是 SEED 會 throw，
 * 避免保證失敗的按鈕）；none 是提示/占位不可執行。
 */
const APPLYABLE_KINDS: ReadonlySet<RecommendedAction['kind']> = new Set([
  'switch_backend',
  'install_winetricks',
  'install_dxvk',
  'reinstall_wine_variant',
  'change_setting'
])

function isApplyable(kind: RecommendedAction['kind']): boolean {
  return APPLYABLE_KINDS.has(kind)
}

/** ExecutionResult | HelmsmanError → 顯示用的色調 + 文案。 */
function describeApply(
  res: ExecutionResult | HelmsmanError,
  t: TFunction
): ApplyOutcome {
  if ('error' in res) return { tone: 'err', text: res.error }
  switch (res.status) {
    case 'executed':
      // 不自動 re-diagnose：log 在遊戲重跑前不會變，重診會給相同結果誤導使用者。
      return {
        tone: 'ok',
        text: t(
          'game.ai.apply.executed',
          'Applied. Restart the game, then run diagnosis again.'
        )
      }
    case 'blocked_needs_confirmation':
      // 新架構下＝使用者在原生確認框按了「否」。
      return { tone: 'warn', text: t('game.ai.apply.cancelled', 'Cancelled.') }
    case 'blocked_steam_lock':
      // 設計性阻擋（§11），非錯誤；detail 已是人話。
      return { tone: 'warn', text: res.detail }
    default:
      // failed / invalid_params / skipped_not_executable：detail 已收口，不洩漏堆疊。
      return { tone: 'err', text: res.detail }
  }
}

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
