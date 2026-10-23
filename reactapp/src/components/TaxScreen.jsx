/**
 * Historical module path compatibility, not a second tax calculator.
 * All new tax calculations use the scoped, verified TY2026-27 new-regime
 * screen. Never revive the old-vs-new comparison UI at this import path.
 */
export { default } from './NewRegimeTaxScreen.jsx';
