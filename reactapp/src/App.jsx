import { useState, useEffect, useMemo, useRef, lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import './App.css';
import RecommendationDashboard from './RecommendationDashboard';
import Sidebar from './components/Sidebar';
import GenieChat from './components/GenieChat';
import ErrorBoundary from './components/ErrorBoundary';
import * as api from './services/api';
import { useAuth } from './context/AuthContext';
import { assertKnownBackendInstrumentTypes } from './utils/instrumentTypeMap';
import { investmentDatabase } from './investmentDatabase';
import { financialProfileKey } from './utils/financialProfile';
import { assertBackendMonthlyAllocation, assertBackendRecommendationInstrument } from './utils/recommendationPresentation';
import { isFinancialCalculationFresh } from './utils/financialFreshness';
import {
  hasCompleteFinancialStateBinding,
  isExactAllocationSuccessor,
  matchesProfileState,
  sameFinancialState,
} from './utils/financialStateBinding';
import { fromSearchParams, toSearchParams, resolveNavigation, NAV_PAGES, DESKTOP_PROGRESS_DESTINATIONS } from './utils/navigationMap';

// ── Lazy-loaded page components (code-split for faster initial load) ──
const WhereToInvestScreen = lazy(() => import('./components/WhereToInvestScreen'));
const TaxesHub = lazy(() => import('./components/TaxesHub'));
const ProgressHub = lazy(() => import('./components/ProgressHub'));
const JourneyPage = lazy(() => import('./components/JourneyPage'));
const GenieProofEntry = lazy(() => import('./components/GenieProofEntry'));
const AllocationPlanner = lazy(() => import('./components/AllocationPlanner'));
const ProfileEditor = lazy(() => import('./ProfileEditor'));
const HelpTourScreen = lazy(() => import('./HelpTourScreen'));
const DeepDiveModal = lazy(() => import('./components/DeepDiveModal'));
const ComparisonTableModal = lazy(() => import('./ComparisonTableModal'));
const ProfilePage = lazy(() => import('./components/ProfilePage'));
const AuthPage = lazy(() => import('./components/AuthPage'));
const LandingPage = lazy(() => import('./LandingPage'));
// Navigation is discoverable; authenticated backend readiness gates operations.
const NAVIGATION_OPTIONS = { allowGenieProof: true };

// ── Bounded retry helper for deferred advisory generation ──
// A crashed server claim becomes reclaimable after two minutes. Continue the
// secondary advisory check past that boundary without delaying the core plan.
// eslint-disable-next-line react-refresh/only-export-components
export const ADVISORY_RETRY_DELAYS_MS = [1000, 1500, 2500, 4000, 6000, 9000, 13500, 15000, 15000, 15000, 15000, 15000, 15000];
const ADVISORY_GENERATION_CONFLICT_CODE = 'ADVISORY_GENERATION_IN_PROGRESS';

function isAdvisoryGenerationConflict(error) {
  return error?.status === 409 && error?.code === ADVISORY_GENERATION_CONFLICT_CODE;
}

function profileOperationIdentity({ profileId, profileVersion, profileKey }) {
  return JSON.stringify([profileId || null, Number(profileVersion ?? 1), profileKey || '']);
}

// eslint-disable-next-line react-refresh/only-export-components
export function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('Request cancelled.');
      err.code = 'REQUEST_ABORTED';
      return reject(err);
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error('Request cancelled.');
      err.code = 'REQUEST_ABORTED';
      reject(err);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

// eslint-disable-next-line react-refresh/only-export-components
export async function fetchDeferredAdvisoryWithBoundedRetry(
  fetchFn,
  recommendationId,
  { signal, retryDelays = ADVISORY_RETRY_DELAYS_MS, onConflict } = {}
) {
  let attempt = 0;
  while (true) {
    try {
      return await fetchFn(recommendationId, { signal });
    } catch (err) {
      if (err?.code === 'REQUEST_ABORTED' || err?.name === 'AbortError' || signal?.aborted) {
        throw err;
      }
      if (isAdvisoryGenerationConflict(err)) {
        if (typeof onConflict === 'function') {
          onConflict();
        }
        if (attempt < retryDelays.length) {
          const delayMs = retryDelays[attempt];
          attempt += 1;
          await wait(delayMs, signal);
          continue;
        }
        // The bounded retry window ended without a terminal server result.
        // Keep the financial recommendation and show a truthful delayed state.
        return {
          advisory_text: null,
          advisory_explanation: { status: 'DELAYED' },
        };
      }
      // Genuine terminal error
      throw err;
    }
  }
}

// eslint-disable-next-line react-refresh/only-export-components
export function advisoryMatchesCurrentFinancialState(current, advisory) {
  if (!hasCompleteFinancialStateBinding(current)) return false;
  const currentRecommendationId = current?.recommendationId;
  const advisoryRecommendationId = advisory?.recommendationId;
  const currentRevision = Number(current?.allocation_revision);
  const advisoryRevision = Number(advisory?.allocation_revision);
  const currentRevisionId = current?.allocation_revision_id;
  const advisoryRevisionId = advisory?.allocation_revision_id;
  const currentFingerprint = current?.portfolio_fingerprint;
  const advisoryFingerprint = advisory?.portfolio_fingerprint;

  return typeof currentRecommendationId === 'string'
    && currentRecommendationId.length > 0
    && typeof advisoryRecommendationId === 'string'
    && advisoryRecommendationId === currentRecommendationId
    && Number.isSafeInteger(currentRevision)
    && currentRevision > 0
    && Number.isSafeInteger(advisoryRevision)
    && advisoryRevision === currentRevision
    && typeof currentRevisionId === 'string'
    && currentRevisionId.length > 0
    && typeof advisoryRevisionId === 'string'
    && advisoryRevisionId === currentRevisionId
    && typeof currentFingerprint === 'string'
    && currentFingerprint.length > 0
    && typeof advisoryFingerprint === 'string'
    && advisoryFingerprint === currentFingerprint
    && advisory.profileId === current.profileId
    && Number(advisory.profile_version) === Number(current.profile_version)
    && advisory.profile_input_hash === current.profile_input_hash
    && advisory.recommendation_fingerprint === current.recommendation_fingerprint
    && advisory.recommendation_policy_version === current.recommendation_policy_version
    && advisory.regulatory_rule_version === current.regulatory_rule_version
    && advisory.return_assumption_hash === current.return_assumption_hash;
}

/* ===== DASHBOARD SHELL - Sidebar + Pages + Chatbot ===== */
const DashboardShell = ({ userProfile, onProfileUpdate, initialRecommendation = null }) => {
  const navigate = useNavigate();
  const { logout } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  // URL search params are the SINGLE source of truth for navigation
  const { page: activePage, tab: activeTab, needsReplace } = useMemo(
    () => fromSearchParams(searchParams, NAVIGATION_OPTIONS),
    [searchParams]
  );

  // Normalize initial or malformed URLs with replace: true to prevent history pollution
  useEffect(() => {
    const legacyDesktop = activePage === NAV_PAGES.PROGRESS
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(min-width: 769px)').matches;
    if (needsReplace || legacyDesktop) {
      const destination = legacyDesktop
        ? { page: DESKTOP_PROGRESS_DESTINATIONS[activeTab] || NAV_PAGES.GOALS, tab: null }
        : { page: activePage, tab: activeTab };
      setSearchParams(toSearchParams(destination), { replace: true });
    }
  }, [needsReplace, activePage, activeTab, setSearchParams]);

  const navigateTo = (target, options = { replace: false }) => {
    const requestsComparison = target === 'compare'
      || (target && typeof target === 'object' && (
        target.page === 'compare'
        || (target.page === 'advanced' && target.tab === 'comparison')
      ));
    const resolved = requestsComparison
      ? { page: NAV_PAGES.HOME, tab: null }
      : resolveNavigation(target, undefined, NAVIGATION_OPTIONS);
    if (requestsComparison) setShowComparisonTable(true);
    const legacyDesktop = resolved.page === NAV_PAGES.PROGRESS
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(min-width: 769px)').matches;
    const destination = legacyDesktop
      ? { page: DESKTOP_PROGRESS_DESTINATIONS[resolved.tab] || NAV_PAGES.GOALS, tab: null }
      : resolved;
    setSearchParams(toSearchParams(destination), options);
  };

  const [deepDiveSelection, setDeepDiveSelection] = useState(null);
  const [deepDiveInitialTab, setDeepDiveInitialTab] = useState('Overview');
  const [showComparisonTable, setShowComparisonTable] = useState(false);
  const [backendRecs, setBackendRecs] = useState(null);
  const [backendFallback, setBackendFallback] = useState(null);
  const [isRecommendationLoading, setIsRecommendationLoading] = useState(true);
  const [isAdvisoryLoading, setIsAdvisoryLoading] = useState(false);
  const [profileReloadGeneration, setProfileReloadGeneration] = useState(0);
  const skipProfileRestoreRef = useRef(null);
  const operationRef = useRef(0);
  const controllerRef = useRef(null);
  const chatLogoutCancellationRef = useRef(null);
  const backendRecsRef = useRef(backendRecs);

  // Stable serialized key - changes ONLY when profile data changes, not on every render
  const profileKey = useMemo(() => financialProfileKey(userProfile), [userProfile]);
  const profileId = userProfile.profileId;
  const profileVersion = Number(userProfile.version ?? 1);
  const currentProfileIdentity = profileOperationIdentity({ profileId, profileVersion, profileKey });
  const activeProfileRef = useRef({ profileId, profileVersion, profileKey });
  activeProfileRef.current = { profileId, profileVersion, profileKey };

  const writeBackendRecs = (nextOrUpdater) => {
    const next = typeof nextOrUpdater === 'function' ? nextOrUpdater(backendRecsRef.current) : nextOrUpdater;
    backendRecsRef.current = next;
    setBackendRecs(next);
    return next;
  };

  const invalidateOperations = () => {
    operationRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    return operationRef.current;
  };

  const beginOperation = () => {
    invalidateOperations();
    const controller = new AbortController();
    controllerRef.current = controller;
    const token = {
      id: operationRef.current,
      controller,
      profileId: activeProfileRef.current.profileId,
      profileVersion: activeProfileRef.current.profileVersion,
      profileKey: activeProfileRef.current.profileKey,
    };
    return token;
  };

  const operationIsCurrent = (token) => Boolean(token
    && operationRef.current === token.id
    && !token.controller.signal.aborted
    && activeProfileRef.current.profileId === token.profileId
    && activeProfileRef.current.profileVersion === token.profileVersion
    && activeProfileRef.current.profileKey === token.profileKey);

  const refreshCanonicalRecommendationAfterSupersession = async (token) => {
    if (!operationIsCurrent(token)) return;
    writeBackendRecs(null);
    setBackendFallback(null);
    setIsRecommendationLoading(true);
    setIsAdvisoryLoading(false);
    try {
      const canonical = await api.getCurrentRecommendation(token.profileId, { signal: token.controller.signal });
      if (!operationIsCurrent(token)) return;
      if (!matchesProfileState(canonical, userProfile)
          || !isFinancialCalculationFresh(canonical?.calculation_freshness)) {
        throw new Error('The canonical recommendation changed with the financial profile.');
      }
      writeBackendRecs(canonical);
    } catch (error) {
      if (!operationIsCurrent(token)
          || error?.code === 'REQUEST_ABORTED'
          || error?.name === 'AbortError') return;
      writeBackendRecs(null);
      setBackendFallback({
        message: 'Your financial recommendation changed. Refresh it before using personalized results.',
        detail: error?.message || null,
      });
    } finally {
      if (operationIsCurrent(token)) setIsRecommendationLoading(false);
    }
  };

  useEffect(() => {
    const effectIdentity = profileOperationIdentity(activeProfileRef.current);
    if (skipProfileRestoreRef.current === effectIdentity) {
      skipProfileRestoreRef.current = null;
      return undefined;
    }
    const token = beginOperation();
    const { controller } = token;
    const fetchBackendData = async () => {
      try {
        setIsRecommendationLoading(true);
        setIsAdvisoryLoading(false);
        writeBackendRecs(null); // Clear stale data immediately
        setBackendFallback(null);
        const activeProfileId = token.profileId;
        if (!activeProfileId) {
          throw new Error('Backend profile creation did not return a profileId.');
        }
        const recResponse = matchesProfileState(initialRecommendation, userProfile)
          ? initialRecommendation
          : await api.getCurrentRecommendation(activeProfileId, { signal: controller.signal });
        if (!operationIsCurrent(token)) return;
        if (!matchesProfileState(recResponse, userProfile)
            || !isFinancialCalculationFresh(recResponse?.calculation_freshness)) {
          throw new Error('The server did not confirm the complete current financial-state binding for this profile.');
        }
        writeBackendRecs(recResponse);
        setBackendFallback(null);
        setIsRecommendationLoading(false);

        // Two-phase fetch: deferred advisory generation
        if (recResponse?.recommendationId && (recResponse.advisory_explanation?.status === 'PENDING' || !recResponse.advisory_text)) {
          setIsAdvisoryLoading(true);
          try {
            const advResponse = await fetchDeferredAdvisoryWithBoundedRetry(
              api.fetchAdvisory,
              recResponse.recommendationId,
              {
                signal: controller.signal,
                onConflict: () => {
                  if (operationIsCurrent(token)) {
                    writeBackendRecs(prev => {
                      if (!advisoryMatchesCurrentFinancialState(prev, recResponse)) return prev;
                      return {
                        ...prev,
                        advisory_explanation: {
                          ...(prev.advisory_explanation || {}),
                          status: 'GENERATING',
                        },
                      };
                    });
                  }
                },
              }
            );
            if (operationIsCurrent(token) && advResponse) {
              writeBackendRecs(prev => {
                const delayed = advResponse.advisory_explanation?.status === 'DELAYED';
                if (!advisoryMatchesCurrentFinancialState(prev, delayed ? recResponse : advResponse)) return prev;
                return {
                  ...prev,
                  // A null/omitted server value means the advisory is not
                  // available for this response; never resurrect prior text.
                  advisory_text: advResponse.advisory_text ?? null,
                  advisory_explanation: advResponse.advisory_explanation || { status: 'GENERATING' },
                };
              });
            }
          } catch (advErr) {
            if (operationIsCurrent(token) && advErr?.code !== 'REQUEST_ABORTED' && advErr?.name !== 'AbortError') {
              if (isAdvisoryGenerationConflict(advErr)) {
                // 409 Conflict: Another request is generating the advisory.
                // Keep advisory state as GENERATING, never mark FAILED on 409.
                writeBackendRecs(prev => {
                  if (!advisoryMatchesCurrentFinancialState(prev, recResponse)) return prev;
                  return {
                    ...prev,
                    advisory_explanation: {
                      ...(prev.advisory_explanation || {}),
                      status: 'GENERATING',
                    },
                  };
                });
              } else if (advErr?.code === 'RECOMMENDATION_SUPERSEDED') {
                await refreshCanonicalRecommendationAfterSupersession(token);
              } else {
                console.warn('Deferred advisory generation failed:', advErr);
                writeBackendRecs(prev => {
                  if (!advisoryMatchesCurrentFinancialState(prev, recResponse)) return prev;
                  return {
                    ...prev,
                    advisory_explanation: {
                      ...(prev.advisory_explanation || {}),
                      status: 'FAILED',
                      error: advErr.message,
                    },
                  };
                });
              }
            }
          } finally {
            if (operationIsCurrent(token)) setIsAdvisoryLoading(false);
          }
        }
      } catch (err) {
        if (err?.code === 'REQUEST_ABORTED' || !operationIsCurrent(token)) return;
        console.error("Failed to fetch backend recommendations:", err);
        writeBackendRecs(null);
        // Never regenerate silently: the user must confirm creation of new
        // canonical financial state, and only recoverable stale/missing states
        // can advertise that action.
        const canRegenerate = err?.code === 'STALE_RECOMMENDATION'
          || (err?.status === 404 && err?.code !== 'PROFILE_NOT_FOUND');
        setBackendFallback({
          message: canRegenerate
            ? 'Your saved recommendation needs to be regenerated'
            : 'Authoritative recommendations are temporarily unavailable',
          detail: err?.message || null,
          canRegenerate,
        });
        setIsRecommendationLoading(false);
      }
    };
    fetchBackendData();
    return () => {
      if (operationRef.current === token.id) operationRef.current += 1;
      controller.abort();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  // userProfile's identity is represented by profileId, version and its stable key.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, profileVersion, profileKey, initialRecommendation, profileReloadGeneration]);

  useEffect(() => () => {
    // Cross-tab sign-out and route teardown bypass handleLogout. Invalidate
    // any in-flight recompute before its promise can update an unmounted shell.
    operationRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  const handleLogout = async () => {
    invalidateOperations();
    chatLogoutCancellationRef.current?.();
    try {
      await logout();
    } catch (error) {
      // Logout can fail while the authenticated dashboard remains mounted. The
      // recommendation request above was aborted, so start a fresh canonical
      // restore instead of leaving its loading/context state stuck forever.
      // A same-profile save can leave the normal restore skip armed when its
      // effect dependencies did not change; it must not suppress this retry.
      skipProfileRestoreRef.current = null;
      setProfileReloadGeneration(generation => generation + 1);
      throw error;
    }
    navigate('/login', { replace: true });
  };

  // Backend response is the only source of personalized recommendation truth.
  const currentRecommendationState = isFinancialCalculationFresh(backendRecs?.calculation_freshness)
      && matchesProfileState(backendRecs, userProfile)
    ? backendRecs
    : null;
  const currentFinancialStateIdentity = currentRecommendationState
    ? JSON.stringify([
      currentRecommendationState.profileId,
      currentRecommendationState.profile_version,
      currentRecommendationState.state_provenance?.stateId,
      currentRecommendationState.recommendationId,
      currentRecommendationState.allocation_revision,
      currentRecommendationState.allocation_revision_id,
      currentRecommendationState.profile_input_hash,
      currentRecommendationState.portfolio_fingerprint,
      currentRecommendationState.recommendation_fingerprint,
    ])
    : null;
  const deepDiveInvestment = deepDiveSelection?.profileIdentity === currentProfileIdentity
      && deepDiveSelection?.financialStateIdentity === currentFinancialStateIdentity
    ? deepDiveSelection.investment
    : null;
  const setDeepDiveInvestment = (investment) => {
    setDeepDiveSelection(investment && currentFinancialStateIdentity
      ? {
        investment,
        profileIdentity: currentProfileIdentity,
        financialStateIdentity: currentFinancialStateIdentity,
      }
      : null);
  };
  useEffect(() => {
    if (deepDiveSelection && (deepDiveSelection.profileIdentity !== currentProfileIdentity
        || deepDiveSelection.financialStateIdentity !== currentFinancialStateIdentity)) {
      setDeepDiveSelection(null);
    }
  }, [deepDiveSelection, currentProfileIdentity, currentFinancialStateIdentity]);

  const recommendations = useMemo(() => {
    if (!backendRecs) return [];
    if (!currentRecommendationState) return [];

    assertKnownBackendInstrumentTypes(currentRecommendationState.instruments?.map(bi => bi.type), 'recommendation merge');

    // Treat backend response as the single source of truth for order, ranking, and allocations.
    // Map over backend instruments directly to preserve their exact order and allocations.
    const merged = (currentRecommendationState.instruments || []).map((bi) => {
      assertBackendRecommendationInstrument(bi);

      // Look up full display attributes from the investment database catalog
      const dbMatch = investmentDatabase.find(inv => 
        inv.id === bi.id
      );
      if (!dbMatch) throw new TypeError(`Frontend catalog is missing authoritative instrument ${bi.id}`);

      const backendWeight = Number(bi.allocationWeight);
      if (!Number.isFinite(backendWeight) || backendWeight < 0 || backendWeight > 1) {
        throw new Error(`Backend returned an invalid allocation weight for ${bi.id || bi.type}`);
      }

      const allocation = assertBackendMonthlyAllocation(
        currentRecommendationState.dashboard_projection?.instrument_monthly_allocations?.[bi.id],
        bi.id || bi.type,
      );

      return {
        ...dbMatch,
        // Enriched presentation metadata from the catalog
        id: bi.id,
        name: bi.name,
        type: bi.type,
        abbr: dbMatch?.abbr || bi.type,
        color: dbMatch?.color || '#38bdf8',
        desc: dbMatch?.desc || '',
        category: bi.assetClass,
        cat: bi.assetClass,
        assetClass: bi.assetClass,
        riskLabel: bi.riskLevel,
        risk: bi.riskScore,
        lockIn: bi.lockIn,
        lock_in_years: bi.lockIn,
        goalTags: [...bi.tags],
        
        // Dynamic values from backend response
        monthly_allocation: allocation,
        postTaxReturn: null,
        effectiveYield: bi.effectiveYield,
        returnBasis: bi.returnBasis,
        nominalReturn: bi.nominalReturn,
        rate: bi.nominalReturn,
        expectedReturn: bi.nominalReturn,
        // A reference-catalog range must not replace the current server assumption.
        returnRange: undefined,
        expected_return_min: undefined,
        expected_return_max: undefined,
        returnAssumptionVersion: currentRecommendationState.return_assumption_version,
        allocationWeight: backendWeight,
        allocation_pct: Number(bi.allocation_pct),
        score: Number(bi.score),
        scoreFactors: { ...bi.scoreFactors },
        taxClassification: bi.taxClassification ?? null,
        ml_confidence: currentRecommendationState.confidence_scores?.[bi.type] ?? null,
        advisory_text: currentRecommendationState.advisory_text,
        _source: 'backend',
      };
    });

    const weightTotal = merged.reduce((sum, item) => sum + item.allocationWeight, 0);
    if (merged.length > 0 && Math.abs(weightTotal - 1) > 0.001) {
      throw new Error(`Backend allocation weights must total 1; received ${weightTotal}`);
    }
    return merged;
  }, [backendRecs, currentRecommendationState]);
  const handleLearnMore = (investment, initialTab = 'Overview') => {
    setDeepDiveInitialTab(initialTab || 'Overview');
    setDeepDiveInvestment(investment);
  };

  const handleRebalanceSave = async (updated, expectedFinancialStateIdentity) => {
    if (expectedFinancialStateIdentity !== currentFinancialStateIdentity) {
      alert('Your portfolio changed since this page was loaded. Refresh before saving this rebalance.');
      return;
    }
    const predecessor = backendRecsRef.current;
    const token = beginOperation();
    // The prior advisory request is bound to the predecessor state and has
    // just been aborted by beginOperation; its guarded finally cannot clear
    // this flag after the new operation owns the UI state.
    setIsAdvisoryLoading(false);
    try {
      if (!currentRecommendationState
          || !sameFinancialState(predecessor, currentRecommendationState)
          || !matchesProfileState(predecessor, userProfile)) {
        throw new Error('The current recommendation is unavailable until its financial-state freshness is verified.');
      }
      const activeProfileId = token.profileId;

      if (!activeProfileId) {
        throw new Error("Could not build user profile for database update.");
      }

      const weights = {};
      updated.forEach(item => {
        weights[item.id] = Number(item.allocationWeight);
      });

      const response = await api.updateRecommendationWeights(activeProfileId, weights, {
        recommendationId: predecessor.recommendationId,
        expectedAllocationRevision: predecessor.allocation_revision,
        expectedPortfolioFingerprint: predecessor.portfolio_fingerprint,
      });

      if (!operationIsCurrent(token)) return;
      let current = response;
      if (!isExactAllocationSuccessor(predecessor, current)
          || !sameFinancialState(backendRecsRef.current, predecessor)) {
        // A committed mutation response is accepted only as the exact CAS successor.
        // Otherwise reconcile from the canonical server pointer; never merge fields.
        current = await api.getCurrentRecommendation(activeProfileId, { signal: token.controller.signal });
      }
      if (!operationIsCurrent(token) || !matchesProfileState(current, userProfile)) return;
      if (current.recommendationId !== predecessor.recommendationId
          || Number(current.allocation_revision) <= Number(predecessor.allocation_revision)) {
        throw new Error('The canonical portfolio state did not advance from the expected allocation revision.');
      }
      writeBackendRecs(current);

      alert('Rebalanced portfolio saved! Projections and dashboard updated in real-time.');
    } catch (err) {
      if (!operationIsCurrent(token)) return;
      try {
        const canonical = await api.getCurrentRecommendation(token.profileId, { signal: token.controller.signal });
        if (operationIsCurrent(token) && matchesProfileState(canonical, userProfile)) {
          writeBackendRecs(canonical);
        } else if (operationIsCurrent(token)) {
          writeBackendRecs(null);
        }
      } catch {
        if (operationIsCurrent(token)) {
          writeBackendRecs(null);
          setBackendFallback({
            message: 'The portfolio change could not be reconciled. Refresh the current recommendation before using personalized results.',
            detail: err?.message || null,
          });
        }
      }
      if (!operationIsCurrent(token)) return;
      if (err?.status === 409 || ['ALLOCATION_STATE_CHANGED', 'ALLOCATION_REVISION_CONFLICT', 'RECOMMENDATION_SUPERSEDED'].includes(err?.code)) {
        alert('Your portfolio changed since this page was loaded. Refresh before saving this rebalance.');
      } else {
        alert('Failed to save rebalanced portfolio: ' + err.message);
      }
    }
  };

  const handleAuthoritativeRecompute = async (profile = userProfile, committedRecommendation = null) => {
    const targetProfileId = profile?.profileId || profile?._id;
    if (!targetProfileId) return;
    const targetProfileVersion = Number(profile.version ?? 1);
    const targetProfileKey = financialProfileKey(profile);
    activeProfileRef.current = {
      profileId: targetProfileId,
      profileVersion: targetProfileVersion,
      profileKey: targetProfileKey,
    };
    const token = beginOperation();
    setIsRecommendationLoading(true);
    setIsAdvisoryLoading(false);
    writeBackendRecs(null);
    setBackendFallback(null);
    try {
      const recResponse = committedRecommendation
        || await api.getRecommendations(targetProfileId, { retries: 0, signal: token.controller.signal });
      if (!operationIsCurrent(token)) return;
      if (!matchesProfileState(recResponse, profile)
          || !isFinancialCalculationFresh(recResponse?.calculation_freshness)) {
        throw new Error('The server did not confirm the complete current financial-state binding for this profile.');
      }
      writeBackendRecs(recResponse);
      setIsRecommendationLoading(false);
      if (recResponse?.recommendationId && (recResponse.advisory_explanation?.status === 'PENDING' || !recResponse.advisory_text)) {
        setIsAdvisoryLoading(true);
        try {
          const advisory = await fetchDeferredAdvisoryWithBoundedRetry(api.fetchAdvisory, recResponse.recommendationId, {
            signal: token.controller.signal,
            onConflict: () => {
              if (!operationIsCurrent(token)) return;
              writeBackendRecs(prev => {
                if (!advisoryMatchesCurrentFinancialState(prev, recResponse)) return prev;
                return {
                  ...prev,
                  advisory_explanation: {
                    ...(prev.advisory_explanation || {}),
                    status: 'GENERATING',
                  },
                };
              });
            },
          });
          if (advisory && operationIsCurrent(token)) {
            writeBackendRecs(prev => advisoryMatchesCurrentFinancialState(prev, advisory.advisory_explanation?.status === 'DELAYED' ? recResponse : advisory)
              ? { ...prev, advisory_text: advisory.advisory_text ?? null, advisory_explanation: advisory.advisory_explanation || { status: 'GENERATING' } }
              : prev);
          }
        } catch (advisoryError) {
          if (operationIsCurrent(token)
              && advisoryError?.code !== 'REQUEST_ABORTED' && advisoryError?.name !== 'AbortError') {
            if (advisoryError?.code === 'RECOMMENDATION_SUPERSEDED') {
              await refreshCanonicalRecommendationAfterSupersession(token);
              return;
            }
            writeBackendRecs(prev => {
              if (!advisoryMatchesCurrentFinancialState(prev, recResponse)) return prev;
              return {
                ...prev,
                advisory_explanation: {
                  ...(prev.advisory_explanation || {}),
                  status: isAdvisoryGenerationConflict(advisoryError) ? 'GENERATING' : 'FAILED',
                  ...(isAdvisoryGenerationConflict(advisoryError) ? {} : { error: advisoryError.message }),
                },
              };
            });
          }
        } finally {
          if (operationIsCurrent(token)) setIsAdvisoryLoading(false);
        }
      }
    } catch (err) {
      if (!operationIsCurrent(token) || err?.code === 'REQUEST_ABORTED' || err?.name === 'AbortError') return;
      writeBackendRecs(null);
      setBackendFallback({ message: 'Authoritative recommendations are temporarily unavailable', detail: err?.message || null });
      setIsRecommendationLoading(false);
      setIsAdvisoryLoading(false);
    }
  };

  useEffect(() => api.subscribeProfileChanges(() => {
    const token = beginOperation();
    writeBackendRecs(null);
    setBackendFallback({ message: 'Your profile changed in another tab. Refreshing your current financial plan.' });
    setIsRecommendationLoading(true);
    setIsAdvisoryLoading(false);
    void (async () => {
      try {
        const canonicalProfile = await api.getCurrentProfile({ retries: 0, signal: token.controller.signal });
        if (!operationIsCurrent(token)) return;
        const canonicalProfileId = canonicalProfile?.profileId || canonicalProfile?._id;
        if (!canonicalProfileId || canonicalProfileId !== token.profileId
            || financialProfileKey(canonicalProfile) === token.profileKey) {
          writeBackendRecs(null);
          setBackendFallback({ message: 'The current profile could not be verified. Recalculate before using personalized results.' });
          setIsRecommendationLoading(false);
          return;
        }
        skipProfileRestoreRef.current = profileOperationIdentity({
          profileId: canonicalProfileId,
          profileVersion: canonicalProfile.version,
          profileKey: financialProfileKey(canonicalProfile),
        });
        onProfileUpdate(canonicalProfile);
        void handleAuthoritativeRecompute(canonicalProfile);
      } catch (error) {
        if (!operationIsCurrent(token) || error?.code === 'REQUEST_ABORTED' || error?.name === 'AbortError') return;
        writeBackendRecs(null);
        setBackendFallback({ message: 'Your profile changed, but the latest version could not be verified. Recalculate before using personalized results.' });
        setIsRecommendationLoading(false);
      }
    })();
  }), [onProfileUpdate, userProfile]);

  const handleCommittedProfileUpdate = (updatedProfile, { recommendation: committedRecommendation = null } = {}) => {
    const updatedProfileId = updatedProfile?.profileId || updatedProfile?._id;
    if (!updatedProfileId) {
      onProfileUpdate(updatedProfile);
      return;
    }
    const profileKey = financialProfileKey(updatedProfile);
    skipProfileRestoreRef.current = profileOperationIdentity({
      profileId: updatedProfileId,
      profileVersion: updatedProfile.version,
      profileKey,
    });
    onProfileUpdate(updatedProfile);
    void handleAuthoritativeRecompute(updatedProfile, committedRecommendation);
  };

  const handleProfileChangeStart = () => {
    invalidateOperations();
    setDeepDiveSelection(null);
    writeBackendRecs(null);
    // Keep personalized chat history/session binding paused until this profile
    // edit is either confirmed or its canonical recommendation is restored.
    setIsRecommendationLoading(true);
    setIsAdvisoryLoading(false);
    setBackendFallback({ message: 'Your financial profile is changing. Recommendations are temporarily unavailable.' });
  };

  const handleProfileChangeFailure = async () => {
    const token = beginOperation();
    writeBackendRecs(null);
    setIsRecommendationLoading(true);
    setBackendFallback(null);
    try {
      const restoredProfile = await api.getCurrentProfile({ retries: 0, signal: token.controller.signal });
      if (!operationIsCurrent(token)) return;
      if (!restoredProfile?.profileId && !restoredProfile?._id) throw new Error('The saved profile could not be verified.');
      onProfileUpdate(restoredProfile);
      setProfileReloadGeneration(value => value + 1);
      setBackendFallback({
        message: 'Profile saved state restored. Verifying the recommendation against its current version.',
      });
    } catch (error) {
      if (!operationIsCurrent(token)) return;
      writeBackendRecs(null);
      setBackendFallback({
        message: 'Your profile was not confirmed after the save error. Recalculate before using personalized results.',
        detail: error?.message || null,
      });
    } finally {
      if (operationIsCurrent(token)) setIsRecommendationLoading(false);
    }
  };

  const renderPage = () => {
    switch (activePage) {
      case NAV_PAGES.HOME:
        return (
          <ErrorBoundary>
            <RecommendationDashboard
              userProfile={userProfile}
              recommendations={recommendations}
              recommendationMeta={currentRecommendationState}
              isLoading={isRecommendationLoading}
              isAdvisoryLoading={isAdvisoryLoading}
              explanation={currentRecommendationState?.explanation || null}
              fallbackNotice={backendFallback}
              onDismissFallbackNotice={() => setBackendFallback(null)}
              onRecalculate={() => void handleAuthoritativeRecompute()}
              onLearnMore={handleLearnMore}
              onExploreAll={() => setShowComparisonTable(true)}
              onRebalance={() => navigateTo('rebalancer')}
              onNavigate={navigateTo}
            />
          </ErrorBoundary>
        );
      case NAV_PAGES.PLAN:
        return (
          <ErrorBoundary>
            <AllocationPlanner
              profile={userProfile}
              recommendations={recommendations}
              recommendationMeta={currentRecommendationState}
              onRecomputePlan={handleAuthoritativeRecompute}
            />
          </ErrorBoundary>
        );
      case NAV_PAGES.INVESTMENTS:
        return (
          <ErrorBoundary>
            <WhereToInvestScreen
              recommendations={recommendations}
              userProfile={userProfile}
              recommendationsLoading={isRecommendationLoading}
              recommendationsError={backendFallback?.message || null}
              recommendationMeta={currentRecommendationState}
              onLearnMore={handleLearnMore}
              onSelectInvestment={setDeepDiveInvestment}
            />
          </ErrorBoundary>
        );
      case NAV_PAGES.TAXES:
        return (
          <ErrorBoundary>
            <TaxesHub
              activeTab={activeTab}
              onTabChange={(newTab) => navigateTo({ page: NAV_PAGES.TAXES, tab: newTab })}
              profile={userProfile}
              recommendations={recommendations}
              recommendationMeta={currentRecommendationState}
              onLearnMore={handleLearnMore}
            />
          </ErrorBoundary>
        );
      case NAV_PAGES.GOALS:
      case NAV_PAGES.GROW_MY_SIP:
      case NAV_PAGES.KEEP_ON_TRACK:
        return (
          <ErrorBoundary>
            <JourneyPage
              page={activePage}
              profile={userProfile}
              financialState={currentRecommendationState}
              financialStateIdentity={currentFinancialStateIdentity}
              recommendations={recommendations}
              onNavigate={navigateTo}
              onSaveRebalance={handleRebalanceSave}
            />
          </ErrorBoundary>
        );
      case NAV_PAGES.PROGRESS:
        return (
          <ErrorBoundary>
            <ProgressHub
              activeTab={activeTab}
              onTabChange={(newTab) => navigateTo({ page: NAV_PAGES.PROGRESS, tab: newTab })}
              profile={userProfile}
              financialState={currentRecommendationState}
              financialStateIdentity={currentFinancialStateIdentity}
              recommendations={recommendations}
              onNavigate={navigateTo}
              onSaveRebalance={handleRebalanceSave}
            />
          </ErrorBoundary>
        );
      case NAV_PAGES.GENIEPROOF:
        return (
          <ErrorBoundary>
            <GenieProofEntry />
          </ErrorBoundary>
        );
      case NAV_PAGES.ACCOUNT:
        return (
          <ErrorBoundary>
            <ProfileEditor
              userProfile={userProfile}
              onProfileUpdate={handleCommittedProfileUpdate}
              onProfileChangeStart={handleProfileChangeStart}
              onProfileChangeFailure={handleProfileChangeFailure}
            />
          </ErrorBoundary>
        );
      case NAV_PAGES.HELP:
        return (
          <ErrorBoundary>
            <HelpTourScreen />
          </ErrorBoundary>
        );
      default:
        return null;
    }
  };

  const lazyFallback = (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '60vh',
      color: 'var(--text-muted)',
      gap: 16
    }}>
      <div style={{
        width: 48,
        height: 48,
        borderRadius: '50%',
        border: '3px solid rgba(56, 189, 248, 0.1)',
        borderTopColor: '#38bdf8',
        animation: 'spin 1s linear infinite'
      }} />
      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
      <div style={{ fontSize: '0.85rem', fontWeight: 600, letterSpacing: '0.05em' }}>Loading Intelligence...</div>
    </div>
  );

  return (
    <div className="app-shell">
      <Sidebar
        activePage={activePage}
        onNavigate={navigateTo}
        onLogout={handleLogout}
        genieProofEnabled
      />
      <main className="app-main">
        <Suspense fallback={lazyFallback}>
          {renderPage()}
        </Suspense>
      </main>

      {/* Deep Dive Modal */}
      <Suspense fallback={null}>
        <DeepDiveModal
          isOpen={!!deepDiveInvestment}
          onClose={() => setDeepDiveInvestment(null)}
          investment={deepDiveInvestment}
          onSelectInvestment={setDeepDiveInvestment}
          userProfile={userProfile}
          allRecommendations={recommendations}
          recommendationMeta={currentRecommendationState}
          horizon={userProfile.investment_horizon_years}
          initialTab={deepDiveInitialTab}
        />
      </Suspense>

      {/* Comparison Table Modal */}
      {showComparisonTable && (
        <Suspense fallback={null}>
          <ComparisonTableModal
            isOpen={true}
            onClose={() => setShowComparisonTable(false)}
            allInvestments={investmentDatabase}
            profile={userProfile}
            recommendations={recommendations}
          />
        </Suspense>
      )}

      {/* Genie Chatbot FAB */}
      <GenieChat
        profile={userProfile}
        recommendations={recommendations}
        recommendationMeta={currentRecommendationState}
        recommendationContextReady={!isRecommendationLoading && Boolean(currentRecommendationState)}
        cancelPendingSendRef={chatLogoutCancellationRef}
        onNavigate={navigateTo}
      />
    </div>
  );
};

function AuthGuard({ children }) {
  const { isAuthenticated, isInitializing } = useAuth();
  if (isInitializing) {
    return <div role="status" aria-live="polite" className="route-loading">Restoring secure session...</div>;
  }
  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<AuthPage />} />
        <Route 
          path="/profile" 
          element={
            <AuthGuard>
              <ProfilePage>
                <DashboardShell />
              </ProfilePage>
            </AuthGuard>
          } 
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Router>
  );
}


export default App;
