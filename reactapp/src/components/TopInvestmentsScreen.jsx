import React, { useMemo, useState } from 'react';
import { ArrowUpRight, ShieldCheck } from 'lucide-react';
import './TopInvestmentsScreen.css';

const MAX_PICKS_PER_GROUP = 5;

const RISK_GROUPS = Object.freeze([
  {
    id: 'easy',
    label: 'Easy to start',
    description: 'Lower relative risk (backend risk levels 1–2).',
    matches: score => score <= 2,
  },
  {
    id: 'moderate',
    label: 'Moderate',
    description: 'Moderate risk (backend risk level 3).',
    matches: score => score === 3,
  },
  {
    id: 'aggressive',
    label: 'Aggressive',
    description: 'Higher relative risk (backend risk levels 4–5).',
    matches: score => score >= 4,
  },
]);

function establishedRiskScore(investment) {
  const score = investment?.risk;
  return typeof score === 'number' && Number.isFinite(score) && score >= 1 && score <= 5
    ? score
    : null;
}

function formatAllocation(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? `${value.toFixed(1).replace(/\.0$/, '')}%`
    : null;
}

export default function TopInvestmentsScreen({
  recommendations = [],
  recommendationsLoading = false,
  recommendationsError = null,
  recommendationMeta = null,
  onLearnMore,
}) {
  const [activeGroupId, setActiveGroupId] = useState(RISK_GROUPS[0].id);
  const activeGroup = RISK_GROUPS.find(group => group.id === activeGroupId) || RISK_GROUPS[0];
  const currentPlanReady = Boolean(recommendationMeta?.recommendationId)
    && Array.isArray(recommendations);

  const groupedPicks = useMemo(() => {
    const usable = Array.isArray(recommendations) ? recommendations : [];
    return Object.fromEntries(RISK_GROUPS.map(group => [
      group.id,
      usable
        // Keep the backend's ranking and allocation order. Grouping only filters
        // the current suitability-approved recommendation; it adds no products.
        .filter(investment => {
          const score = establishedRiskScore(investment);
          return score !== null && group.matches(score);
        })
        .slice(0, MAX_PICKS_PER_GROUP),
    ]));
  }, [recommendations]);

  const picks = groupedPicks[activeGroup.id] || [];

  return (
    <section className="top-investments" data-testid="top-investments-screen">
      <header className="top-investments__header">
        <p className="top-investments__eyebrow">PROFILE-BASED RECOMMENDATIONS</p>
        <h1>Top investment options</h1>
        <p>
          Review up to five options in each risk group from your current, backend-approved plan.
          Your Financial Profile remains the suitability authority.
        </p>
      </header>

      <section className="top-investments__notice" aria-label="Recommendation scope">
        <ShieldCheck size={20} aria-hidden="true" />
        <p>
          These are options already included in your saved recommendation, shown in the order returned by
          WealthGenie. A group can have fewer than five options when your profile does not qualify for more.
        </p>
      </section>

      <section className="top-investments__panel" aria-label="Top recommendations by risk group">
        <div className="top-investments__tabs" role="tablist" aria-label="Risk groups">
          {RISK_GROUPS.map(group => (
            <button
              key={group.id}
              id={`top-investments-tab-${group.id}`}
              type="button"
              role="tab"
              aria-selected={activeGroup.id === group.id}
              aria-controls="top-investments-results"
              className={activeGroup.id === group.id ? 'is-active' : ''}
              onClick={() => setActiveGroupId(group.id)}
            >
              <span>{group.label}</span>
              <span className="top-investments__tab-count">{groupedPicks[group.id]?.length || 0}</span>
            </button>
          ))}
        </div>

        <div className="top-investments__group-heading">
          <div>
            <h2>{activeGroup.label}</h2>
            <p>{activeGroup.description}</p>
          </div>
          <span>{picks.length} of up to {MAX_PICKS_PER_GROUP}</span>
        </div>

        {recommendationsLoading && (
          <p className="top-investments__state" role="status">Checking your current recommendation…</p>
        )}

        {!recommendationsLoading && recommendationsError && (
          <p className="top-investments__error" role="alert">{recommendationsError}</p>
        )}

        {!recommendationsLoading && !recommendationsError && !currentPlanReady && (
          <p className="top-investments__state" role="status">
            A current, verified recommendation is not available. Complete your Financial Profile or refresh your plan.
          </p>
        )}

        {!recommendationsLoading && !recommendationsError && currentPlanReady && picks.length === 0 && (
          <p className="top-investments__state" role="status">
            Your current plan has no options in this risk group. Your saved profile controls which risk levels can appear.
          </p>
        )}

        {!recommendationsLoading && !recommendationsError && currentPlanReady && picks.length > 0 && (
          <div
            id="top-investments-results"
            className="top-investments__list"
            role="tabpanel"
            aria-labelledby={`top-investments-tab-${activeGroup.id}`}
          >
            {picks.map((investment, index) => {
              const allocation = formatAllocation(investment.allocation_pct);
              return (
                <article className="top-investments__item" key={investment.id}>
                  <span className="top-investments__rank" aria-label={`Option ${index + 1}`}>{index + 1}</span>
                  <div className="top-investments__item-copy">
                    <h3>{investment.name}</h3>
                    <p>
                      {investment.riskLabel || `Backend risk level ${establishedRiskScore(investment)}`}
                      {allocation ? ` · ${allocation} of your plan` : ''}
                    </p>
                  </div>
                  {typeof onLearnMore === 'function' && (
                    <button
                      type="button"
                      className="top-investments__open"
                      onClick={() => onLearnMore(investment, 'Where to Invest')}
                      aria-label={`View ${investment.name}`}
                    >
                      View option <ArrowUpRight size={16} aria-hidden="true" />
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </section>
  );
}
