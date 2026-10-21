/**
 * DeepDiveModal — History Tab (normalized projection comparison)
 * Extracted from DeepDiveModal.jsx for maintainability.
 */
import React from 'react';
import { CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area } from 'recharts';

const HistoryTab = ({ inv, historicalData, benchmarkRate, inflationRate, projectionError, projectionLoading }) => {
  return (
    <div className="tab-fade-in">
      <div className="ddm-section-header">Modeled Growth Illustration (Model Policy Scenario)</div>

      {/* Chart Legend */}
      <div style={{ display: 'flex', gap: 24, marginBottom: 12, paddingLeft: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 14, height: 3, background: '#8b5cf6', borderRadius: 2 }} />
          <span style={{ fontSize: '0.72rem', color: '#94a3b8', fontWeight: 600 }}>{inv.name} (Modeled Scenario)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 14, height: 2, background: 'rgba(255,255,255,0.2)', borderRadius: 2, borderTop: '1px dashed rgba(255,255,255,0.3)' }} />
          <span style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 600 }}>Savings Benchmark ({benchmarkRate}%)</span>
        </div>
      </div>

      {projectionLoading && <p role="status" style={{ color: '#7dd3fc', textAlign: 'center' }}>Updating the comparison for the current assumptions…</p>}
      {projectionError && <p role="alert" style={{ color: '#fda4af', textAlign: 'center' }}>Comparison unavailable: {projectionError}</p>}
      {!projectionLoading && !projectionError && historicalData.length === 0 && <p role="status" style={{ color: '#94a3b8', textAlign: 'center' }}>No verified comparison is available for the current assumptions.</p>}
      {!projectionLoading && !projectionError && historicalData.length > 0 && <div style={{ height: 340, background: 'rgba(15, 23, 42, 0.4)', borderRadius: 18, padding: '24px 20px 16px', border: '1px solid var(--ddm-border)' }}>
        <ResponsiveContainer initialDimension={{ width: 1, height: 1 }}>
          <AreaChart data={historicalData}>
            <defs>
              <linearGradient id="colorInv" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3}/>
                <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0}/>
              </linearGradient>
              <linearGradient id="colorFd" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#64748b" stopOpacity={0.08}/>
                <stop offset="95%" stopColor="#64748b" stopOpacity={0}/>
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.03)" vertical={false} />
            <XAxis dataKey="year" stroke="#64748b" tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} />
            <YAxis stroke="#64748b" tick={{ fill: '#64748b', fontSize: 10 }} axisLine={false} tickLine={false} domain={['dataMin - 10', 'dataMax + 10']} />
            <Tooltip 
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                return (
                  <div style={{
                    background: 'rgba(2, 6, 23, 0.95)',
                    border: '1px solid rgba(139, 92, 246, 0.2)',
                    borderRadius: 12,
                    padding: '12px 16px',
                    boxShadow: '0 12px 32px rgba(0,0,0,0.6)',
                    backdropFilter: 'blur(12px)',
                    minWidth: 180,
                  }}>
                    <div style={{ fontSize: '0.7rem', color: '#64748b', fontWeight: 700, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
                    {payload.map((p, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 24, marginBottom: 4 }}>
                        <span style={{ fontSize: '0.78rem', color: p.dataKey === 'investment' ? '#c4b5fd' : '#64748b', fontWeight: 600 }}>
                          {p.dataKey === 'investment' ? `${inv.name}` : 'FD Benchmark'}
                        </span>
                        <span style={{ fontSize: '0.82rem', color: p.dataKey === 'investment' ? '#8b5cf6' : '#94a3b8', fontWeight: 800, fontFamily: "'JetBrains Mono', monospace" }}>
                          ₹{p.value}
                        </span>
                      </div>
                    ))}
                  </div>
                );
              }}
            />
            <Area 
              type="monotone" 
              dataKey="investment" 
              stroke="#8b5cf6" 
              strokeWidth={3} 
              fillOpacity={1} 
              fill="url(#colorInv)" 
              animationDuration={1500}
              name={inv.name}
            />
            <Area type="monotone" dataKey="fd" stroke="rgba(255,255,255,0.15)" strokeDasharray="5 5" strokeWidth={1.5} fill="url(#colorFd)" fillOpacity={1} dot={false} name="FD Benchmark" />
          </AreaChart>
        </ResponsiveContainer>
      </div>}
      <p style={{ color: 'var(--ddm-text-muted)', fontSize: '0.7rem', marginTop: 10, textAlign: 'center', fontStyle: 'italic' }}>
        * Server-modeled growth illustration of ₹100 at policy return assumptions; this is not realized historical backtesting. Inflation comparison uses {inflationRate}%. Actual investment outcomes will vary.
      </p>
    </div>
  );
};

export default HistoryTab;
