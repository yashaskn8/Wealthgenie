/**
 * DeepDiveModal — Calculator Tab (Wealth Projection Engine)
 * Improved accuracy: category matching, tax computation, and lump-sum support.
 * Enhanced UI: year-by-year breakdown, growth multiplier, CAGR display.
 */
import React, { useMemo } from 'react';
import { Shield, TrendingUp, Info, ExternalLink, ArrowUpRight, Calendar, Landmark, IndianRupee } from 'lucide-react';
import { formatINR } from '../../utils/indianNumberFormat';

const CalculatorTab = ({
  inv,
  calcAmount,
  setCalcAmount,
  calcYears,
  setCalcYears,
  calcReturn,
  setCalcReturn,
  calcBounds,
  inflationRate,
  setInflationRate,
  projection,
  projectionError,
  projectionLoading,
}) => {
  const maturityValue = projection?.investmentMaturity ?? null;
  const totalInvested = projection?.totalInvested ?? null;
  const estimatedReturns = projection?.estimatedReturns ?? null;
  const realMaturityValue = projection?.investmentReal ?? null;
  const hasProjection = [maturityValue, totalInvested, estimatedReturns, realMaturityValue]
    .every(value => Number.isFinite(Number(value)));
  const taxRule = { label: 'Open Post-Tax Analysis to supply income and tax regime', color: '#94a3b8' };

  // Growth metrics — derived only from values returned by the projection API.
  const growthMultiplier = hasProjection && totalInvested > 0 ? (maturityValue / totalInvested).toFixed(2) : null;
  const totalReturnPct = hasProjection && totalInvested > 0 ? ((estimatedReturns / totalInvested) * 100).toFixed(1) : null;
  const inflationDrag = hasProjection ? maturityValue - realMaturityValue : null;

  const yearlyBreakdown = useMemo(() => (projection?.yearlyBreakdown || []).map(row => ({
    year: row.year,
    invested: row.invested,
    value: row.investmentNominal,
    gains: row.gains,
  })), [projection]);

  // Show milestone years (first, middle, last, plus any year where multiplier crosses 2x, 3x)
  const milestoneYears = useMemo(() => {
    if (yearlyBreakdown.length <= 6) return yearlyBreakdown;
    const selected = new Set([0, yearlyBreakdown.length - 1]);
    // Add middle
    selected.add(Math.floor(yearlyBreakdown.length / 2));
    // Add quarter points
    selected.add(Math.floor(yearlyBreakdown.length / 4));
    selected.add(Math.floor((yearlyBreakdown.length * 3) / 4));
    // Add multiplier crossings
    for (let i = 0; i < yearlyBreakdown.length; i++) {
      const mult = yearlyBreakdown[i].value / yearlyBreakdown[i].invested;
      if (mult >= 2 && !Array.from(selected).some(s => {
        const m = yearlyBreakdown[s]?.value / yearlyBreakdown[s]?.invested;
        return m >= 2;
      })) selected.add(i);
      if (mult >= 3 && !Array.from(selected).some(s => {
        const m = yearlyBreakdown[s]?.value / yearlyBreakdown[s]?.invested;
        return m >= 3;
      })) selected.add(i);
    }
    return Array.from(selected).sort((a, b) => a - b).map(i => yearlyBreakdown[i]);
  }, [yearlyBreakdown]);

  return (
    <div className="tab-fade-in">
      <div className="ddm-section-header">Wealth Projection Engine</div>

      {/* Range Info Banner */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '14px 20px', borderRadius: '16px', marginBottom: 24,
        background: 'linear-gradient(90deg, rgba(56, 189, 248, 0.1), rgba(56, 189, 248, 0.02))',
        border: '1px solid rgba(56, 189, 248, 0.2)',
        borderLeft: '4px solid #38bdf8',
        fontSize: '0.85rem', color: '#cbd5e1',
        boxShadow: '0 8px 24px -8px rgba(56,189,248,0.1)'
      }}>
        <Info size={18} style={{ flexShrink: 0, color: '#7dd3fc' }} />
        <span>
          This is a user-controlled projection what-if, not a forecast. {calcBounds.returnBoundsBasis === 'GENERIC_WHAT_IF' ? 'Generic return input range' : 'Range around the server model assumption'}: <strong style={{ color: '#38bdf8' }}>{calcBounds.returnMin}%–{calcBounds.returnMax}%</strong>.
          {' '}Time horizon: <strong style={{ color: '#38bdf8' }}>{calcBounds.yearMin}–{calcBounds.yearMax} years</strong> ({calcBounds.yearBoundsBasis === 'GENERIC_WHAT_IF' ? 'generic what-if, not product term' : 'server-declared constraint'}).
          {' '}Neither value is an observed market fact or provider forecast.
        </span>
      </div>

      {(projectionLoading || projectionError) && (
        <div role={projectionError ? 'alert' : 'status'} style={{
          margin: '-12px 0 18px', padding: '10px 14px', borderRadius: 10,
          border: `1px solid ${projectionError ? 'rgba(244,63,94,.3)' : 'rgba(56,189,248,.22)'}`,
          color: projectionError ? '#fda4af' : '#7dd3fc', fontSize: '0.72rem',
          background: projectionError ? 'rgba(244,63,94,.08)' : 'rgba(56,189,248,.06)',
        }}>
          {projectionError ? `Projection unavailable: ${projectionError}` : 'Updating server projection…'}
        </div>
      )}

      <div className="calc-premium-grid">
        <div className="calc-inputs-vertical">
          <div className="calc-field">
            <div className="calc-label-row">
              <label className="metric-label">Monthly SIP Amount</label>
              <span className="calc-value-display">₹{calcAmount.toLocaleString()}</span>
            </div>
            <input
              type="range"
              min="1000" max="500000" step="1000"
              value={calcAmount}
              onChange={e => setCalcAmount(Number(e.target.value))}
              style={{
                '--slider-pct': `${(calcAmount - 1000)/(500000 - 1000) * 100}%`
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', color: '#475569', marginTop: 4 }}>
              <span>₹1,000</span><span>₹5,00,000</span>
            </div>
          </div>
          <div className="calc-field">
            <div className="calc-label-row">
              <label className="metric-label">Time Horizon</label>
              <span className="calc-value-display">{calcYears} {calcYears === 1 ? 'Year' : 'Years'}</span>
            </div>
            <input
              type="range"
              min={calcBounds.yearMin} max={calcBounds.yearMax}
              value={calcYears}
              onChange={e => setCalcYears(Number(e.target.value))}
              style={{
                '--slider-pct': `${(calcYears - calcBounds.yearMin)/Math.max(1, calcBounds.yearMax - calcBounds.yearMin) * 100}%`
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', color: '#475569', marginTop: 4 }}>
              <span>{calcBounds.yearMin} yr</span><span>{calcBounds.yearMax} yrs</span>
            </div>
          </div>
          <div className="calc-field">
            <div className="calc-label-row">
              <label className="metric-label">Assumed Annual Return</label>
              <span className="calc-value-display">{calcReturn}%</span>
            </div>
            <input
              type="range"
              min={calcBounds.returnMin} max={calcBounds.returnMax} step="0.5"
              value={calcReturn}
              onChange={e => setCalcReturn(Number(e.target.value))}
              style={{
                '--slider-pct': `${(calcReturn - calcBounds.returnMin)/Math.max(1, calcBounds.returnMax - calcBounds.returnMin) * 100}%`
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', color: '#475569', marginTop: 4 }}>
              <span>{calcBounds.returnMin}%</span>
              <span style={{ color: '#64748b', fontWeight: 600 }}>Selected assumption: {calcReturn}%</span>
              <span>{calcBounds.returnMax}%</span>
            </div>
          </div>

          <div className="calc-field">
            <div className="calc-label-row">
              <label className="metric-label">Inflation Assumption</label>
              <span className="calc-value-display">{inflationRate}%</span>
            </div>
            <input
              type="range"
              min="0" max="15" step="0.5"
              value={inflationRate}
              onChange={e => setInflationRate(Number(e.target.value))}
              style={{ '--slider-pct': `${inflationRate / 15 * 100}%` }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.6rem', color: '#475569', marginTop: 4 }}>
              <span>0%</span><span>Explicit assumption</span><span>15%</span>
            </div>
          </div>

          {/* Year-by-Year Growth Breakdown */}
          <div style={{
            marginTop: 8,
            padding: '20px 24px',
            background: 'linear-gradient(165deg, rgba(15, 23, 42, 0.5), rgba(2, 6, 23, 0.7))',
            border: '1px solid rgba(255, 255, 255, 0.06)',
            borderRadius: '16px',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <Calendar size={14} style={{ color: '#8b5cf6' }} />
              <span style={{ fontSize: '0.65rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '1px', color: '#94a3b8' }}>Year-by-Year Growth Breakdown</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '50px 1fr 1fr 1fr', gap: '0', fontSize: '0.62rem' }}>
              {/* Header */}
              <div style={{ padding: '8px 6px', color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>Year</div>
              <div style={{ padding: '8px 6px', color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px', borderBottom: '1px solid rgba(255,255,255,0.06)', textAlign: 'right' }}>Invested</div>
              <div style={{ padding: '8px 6px', color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px', borderBottom: '1px solid rgba(255,255,255,0.06)', textAlign: 'right' }}>Value</div>
              <div style={{ padding: '8px 6px', color: '#64748b', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.5px', borderBottom: '1px solid rgba(255,255,255,0.06)', textAlign: 'right' }}>Gains</div>
              {/* Rows */}
              {milestoneYears.map((row, i) => {
                const mult = (row.value / row.invested);
                return (
                  <React.Fragment key={i}>
                    <div style={{ padding: '8px 6px', color: '#cbd5e1', fontWeight: 700, borderBottom: '1px solid rgba(255,255,255,0.03)', fontFamily: "'JetBrains Mono', monospace" }}>
                      {row.year}
                    </div>
                    <div style={{ padding: '8px 6px', color: '#94a3b8', textAlign: 'right', borderBottom: '1px solid rgba(255,255,255,0.03)', fontFamily: "'JetBrains Mono', monospace" }}>
                      {formatINR(row.invested)}
                    </div>
                    <div style={{ padding: '8px 6px', color: '#7dd3fc', fontWeight: 700, textAlign: 'right', borderBottom: '1px solid rgba(255,255,255,0.03)', fontFamily: "'JetBrains Mono', monospace" }}>
                      {formatINR(row.value)}
                    </div>
                    <div style={{ padding: '8px 6px', textAlign: 'right', borderBottom: '1px solid rgba(255,255,255,0.03)', fontFamily: "'JetBrains Mono', monospace" }}>
                      <span style={{ color: row.gains < 0 ? '#f87171' : '#22c55e', fontWeight: 700 }}>
                        {row.gains >= 0 ? '+' : ''}{formatINR(row.gains)}
                      </span>
                      {mult >= 1.5 && (
                        <span style={{ marginLeft: 6, fontSize: '0.55rem', color: mult >= 3 ? '#a78bfa' : mult >= 2 ? '#38bdf8' : '#64748b', fontWeight: 900 }}>
                          {mult.toFixed(1)}×
                        </span>
                      )}
                    </div>
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        </div>

        <div className="calc-sidebar">
          {/* Growth Multiplier Hero */}
          <div style={{
            textAlign: 'center',
            padding: '16px 0 12px',
            borderBottom: '1px solid var(--ddm-border)',
            marginBottom: 4
          }}>
            <div style={{ fontSize: '0.58rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '1.2px', color: '#64748b', marginBottom: 8 }}>
              Money Growth Multiplier
            </div>
            <div style={{
              fontSize: '3rem',
              fontWeight: 900,
              fontFamily: "'JetBrains Mono', monospace",
              background: 'linear-gradient(135deg, #38bdf8, #a78bfa)',
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              letterSpacing: '-0.03em',
              lineHeight: 1,
            }}>
              {growthMultiplier === null ? '—' : `${growthMultiplier}×`}
            </div>
            <div style={{ fontSize: '0.65rem', color: '#94a3b8', marginTop: 6, fontWeight: 600 }}>
              Total Return: <span style={{ color: '#22c55e', fontWeight: 800 }}>{totalReturnPct === null ? '—' : `+${totalReturnPct}%`}</span>
            </div>
          </div>

          <div className="sidebar-stat">
            <span className="sidebar-label">Total Principal Invested</span>
            <span className="sidebar-value" style={{ whiteSpace: 'nowrap' }}>{formatINR(totalInvested)}</span>
          </div>
          <div className="sidebar-stat">
            <span className="sidebar-label">Estimated Compounding Yield</span>
            <span className="sidebar-value" style={{ color: '#22c55e', whiteSpace: 'nowrap' }}>+{formatINR(estimatedReturns)}</span>
          </div>
          <div style={{ borderTop: '1px solid var(--ddm-border)', paddingTop: 16 }}>
            <span className="sidebar-label" style={{ color: '#38bdf8' }}>Gross Maturity Value</span>
            <span className="sidebar-value" style={{ fontSize: '2.2rem', color: '#7dd3fc', textShadow: '0 4px 24px rgba(56, 189, 248, 0.4)', whiteSpace: 'nowrap', display: 'block', marginTop: '8px' }}>{formatINR(maturityValue)}</span>
          </div>

          {/* Post-Tax & Inflation Section */}
          <div style={{ borderTop: '1px solid var(--ddm-border)', paddingTop: 14, marginTop: 6 }}>
            <div className="sidebar-stat" style={{ marginBottom: 10 }}>
              <span className="sidebar-label" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Shield size={11} style={{ color: '#f59e0b' }} /> After Tax
              </span>
              <span className="sidebar-value" style={{ color: '#fbbf24', whiteSpace: 'nowrap', fontSize: '1.1rem' }}>Not calculated</span>
            </div>
            {/* Tax Rule Applied */}
            <div style={{
              padding: '8px 12px',
              borderRadius: '8px',
              background: 'rgba(255, 255, 255, 0.02)',
              border: '1px solid rgba(255, 255, 255, 0.04)',
              marginBottom: 12
            }}>
              <div style={{ fontSize: '0.58rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.8px', color: '#64748b', marginBottom: 3 }}>Tax Rule Applied</div>
              <div style={{ fontSize: '0.7rem', fontWeight: 700, color: taxRule.color, lineHeight: 1.4 }}>{taxRule.label}</div>
            </div>
            <div className="sidebar-stat">
              <span className="sidebar-label" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <TrendingUp size={11} style={{ color: '#f97316' }} /> Today's Value ({inflationRate}% inflation)
              </span>
              <span className="sidebar-value" style={{ color: '#fb923c', whiteSpace: 'nowrap', fontSize: '1.1rem' }}>{formatINR(realMaturityValue)}</span>
              {inflationDrag !== null && inflationDrag > 0 && (
                <span style={{ fontSize: '0.6rem', color: '#f97316', fontWeight: 700, marginTop: 2 }}>
                  Inflation Drag: -{formatINR(Math.round(inflationDrag))}
                </span>
              )}
            </div>
          </div>

          {/* Save / Export Goal */}
          <div className="goal-export-section">
            <button
              className="goal-export-btn goal-export-btn--pdf"
              disabled={!hasProjection}
              onClick={() => {
                if (!hasProjection) return;
                const report = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>WealthGenie – ${inv.name} Goal Report</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:'Inter',system-ui,sans-serif;background:#0f172a;color:#f1f5f9;padding:40px}
  .header{text-align:center;margin-bottom:32px;padding-bottom:24px;border-bottom:1px solid #1e293b}
  .header h1{font-size:1.8rem;font-weight:800;background:linear-gradient(135deg,#8b5cf6,#38bdf8);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .header p{color:#94a3b8;font-size:0.85rem;margin-top:6px}
  .badge{display:inline-block;font-size:0.65rem;font-weight:700;padding:3px 10px;border-radius:6px;background:rgba(139,92,246,0.15);color:#a78bfa;border:1px solid rgba(139,92,246,0.3);margin-top:8px;text-transform:uppercase;letter-spacing:1px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px}
  .card{background:rgba(30,41,59,0.6);border:1px solid rgba(255,255,255,0.06);border-radius:14px;padding:18px}
  .card .label{font-size:0.7rem;color:#94a3b8;text-transform:uppercase;letter-spacing:1px;font-weight:600}
  .card .value{font-size:1.4rem;font-weight:800;margin-top:6px}
  .card .value.green{color:#22c55e}
  .card .value.cyan{color:#38bdf8}
  .card .value.yellow{color:#fbbf24}
  .card .value.orange{color:#fb923c}
  .multiplier{font-size:2.5rem;font-weight:900;text-align:center;padding:24px;background:rgba(56,189,248,0.06);border-radius:16px;border:1px solid rgba(56,189,248,0.15);margin-bottom:24px;color:#7dd3fc}
  .disclaimer{margin-top:32px;padding-top:16px;border-top:1px solid #1e293b;font-size:0.65rem;color:#475569;text-align:center;line-height:1.6}
  @media print{body{background:#fff;color:#0f172a} .card{border:1px solid #e2e8f0} .card .label{color:#64748b} .card .value{color:#0f172a} .card .value.green{color:#16a34a} .card .value.cyan{color:#0284c7} .header h1{-webkit-text-fill-color:#7c3aed}}
</style></head><body>
<div class="header">
  <h1>WealthGenie</h1>
  <p>Wealth Projection Report for <strong>${inv.name}</strong></p>
  <div class="badge">${inv.category} • ${calcYears} Year Horizon • ${calcReturn}% p.a.</div>
</div>
<div class="multiplier">${growthMultiplier}× Growth · +${totalReturnPct}% Total Return</div>
<div class="grid">
  <div class="card"><div class="label">Monthly SIP</div><div class="value cyan">₹${calcAmount.toLocaleString('en-IN')}</div></div>
  <div class="card"><div class="label">Assumed Return</div><div class="value cyan">${calcReturn}% p.a.</div></div>
  <div class="card"><div class="label">Total Principal</div><div class="value">${formatINR(totalInvested)}</div></div>
  <div class="card"><div class="label">Compounding Yield</div><div class="value green">+${formatINR(estimatedReturns)}</div></div>
  <div class="card"><div class="label">Gross Maturity Value</div><div class="value cyan" style="font-size:1.6rem">${formatINR(maturityValue)}</div></div>
  <div class="card"><div class="label">After Tax</div><div class="value yellow">Requires tax context</div></div>
  <div class="card" style="grid-column:span 2"><div class="label">Today's Purchasing Power (${inflationRate}% inflation adjusted)</div><div class="value orange">${formatINR(realMaturityValue)}</div></div>
</div>
<div class="disclaimer">
  Disclaimer: This is a projection based on estimated returns. Past performance does not guarantee future results.<br>
  Post-tax value is intentionally omitted until income source and tax regime are supplied in Post-Tax Analysis. Consult a SEBI-registered advisor.<br><br>
  Generated by WealthGenie • ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}
</div>
</body></html>`;
                const blob = new Blob([report], { type: 'text/html' });
                const url = URL.createObjectURL(blob);
                const w = window.open(url, '_blank');
                setTimeout(() => { w?.print(); }, 600);
              }}
            >
              <ExternalLink size={14} />
              Save Goal Report
            </button>
            <button
              className="goal-export-btn goal-export-btn--copy"
              disabled={!hasProjection}
              onClick={(e) => {
                if (!hasProjection) return;
                const btn = e.currentTarget;
                const summary = `WealthGenie – ${inv.name} Goal Report\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n• Monthly SIP: ₹${calcAmount.toLocaleString('en-IN')}\n• Assumed Return: ${calcReturn}% p.a.\n• Time Horizon: ${calcYears} years\n• Growth Multiplier: ${growthMultiplier}×\n\n• Total Invested: ${formatINR(totalInvested)}\n• Maturity Value: ${formatINR(maturityValue)}\n• After Tax: Requires explicit tax context in Post-Tax Analysis\n• Today's Value (${inflationRate}% inflation): ${formatINR(realMaturityValue)}\n\n* Past performance is not indicative of future results.\nGenerated by WealthGenie • ${new Date().toLocaleDateString('en-IN')}`;
                navigator.clipboard.writeText(summary).then(() => {
                  btn.textContent = '✓ Copied!';
                  btn.style.borderColor = '#22c55e';
                  btn.style.color = '#22c55e';
                  setTimeout(() => {
                    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy Summary';
                    btn.style.borderColor = '';
                    btn.style.color = '';
                  }, 2000);
                });
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              Copy Summary
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CalculatorTab;
