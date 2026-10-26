import { PAGE_ALLOWLIST } from './navigationMap';

export const SAFE_FEATURE_LABELS = Object.freeze({
  goals: 'Explore Goal Planner',
  'grow-my-sip': 'Explore SIP Growth Planner',
  taxes: 'Explore Tax Analysis',
  'keep-on-track': 'Explore Investment Mix Planner',
  investments: 'Explore Investment Options',
  plan: 'Explore Your Investment Plan',
  progress: 'Explore Progress',
});

/**
 * Never execute a model-produced action or display arbitrary supplied URLs.
 * Re-derive every title locally from the canonical page identifier.
 */
export function normalizeFeatureCard(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card) ||
      card.version !== 'genie-feature-card-v1' ||
      card.kind !== 'FEATURE_NAVIGATION_SUGGESTION' ||
      card.tab !== null || card.requiresUserClick !== true ||
      !Object.hasOwn(SAFE_FEATURE_LABELS,card.page) ||
      !PAGE_ALLOWLIST.includes(card.page)) return null;
  return {
    page: card.page,
    tab: null,
    label: SAFE_FEATURE_LABELS[card.page],
  };
}
