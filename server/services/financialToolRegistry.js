import Joi from 'joi';
import { sipFV, lumpSumFV, reverseSIPFromFV } from './projectionEngine.js';
import { computeTax } from './taxEngine.js';
import { computeXIRR } from './xirrCalculator.js';
import {
  solveMinVariance, solveMaxSharpe, solveRiskParity, computeRebalance, evaluatePortfolio,
} from './portfolioEngine.js';
import { PrometheusMetrics } from './metricsCollector.js';
import { INSTRUMENT_PARAMS } from './instrumentConstants.js';
import { buildRecommendationProfile } from './recommendationProfile.js';
import {
  assertPortfolioSuitable, enforceAllocationTargets, resolveConcentrationCap,
} from './RecommendationPipeline.js';
import { MCP_TOOL_POLICY, isMcpToolAllowed } from '../mcp/toolPolicy.js';

/**
 * WealthGenie Centralized Financial Tool Registry
 * Canonical deterministic calculators for explicit backend/MCP workflows.
 * Phase-6 grounded explanation providers are intentionally not connected to
 * this registry; their tool allowlist is empty and they receive evidence only.
 */
const DANGEROUS_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf']);

const VALID_ASSET_KEYS = [
  'Equity_MF', 'ELSS', 'ETF', 'Debt_MF', 'FD', 'Gold', 'NPS', 'PPF',
  'RBI_Bond', 'G-Sec', 'SGB', 'Liquid_MF', 'Arbitrage_MF', 'Hybrid_MF',
  'Index_MF', 'Midcap_MF', 'Smallcap_MF',
];

const SAFE_ALLOCATION_KEY_REGEX = /^(?!__proto__|constructor|prototype|toString|valueOf)[a-zA-Z0-9_-]{1,50}$/;

function validateIsoCalendarDate(value, helpers) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return helpers.error('string.pattern.base');
  const [year, month, day] = value.split('-').map(Number);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > monthLengths[month - 1]) {
    return helpers.error('string.isoDate');
  }
  return value;
}

function canonicalContextProfile(context) {
  return context?.profile ? buildRecommendationProfile(context.profile) : null;
}

function assertProjectionWithinProfile(context, { monthlyInvestment, principal, years }) {
  const profile = canonicalContextProfile(context);
  if (!profile) return null;
  if (monthlyInvestment !== undefined && monthlyInvestment > profile.monthlySavings) {
    throw new Error(`monthlyInvestment exceeds Financial Profile capacity of ${profile.monthlySavings}`);
  }
  if (principal !== undefined && profile.hasLumpSum !== true) {
    throw new Error('principal requires an explicitly declared deployable lump sum in the Financial Profile');
  }
  const deployableLumpSum = profile.hasLumpSum === true ? profile.lumpSumAmount : null;
  if (principal !== undefined && principal > deployableLumpSum) {
    throw new Error(`principal exceeds declared deployable lump sum of ${deployableLumpSum}`);
  }
  if (years > profile.investmentHorizonYears) {
    throw new Error(`years exceeds Financial Profile horizon of ${profile.investmentHorizonYears}`);
  }
  return profile;
}

function calculationClassification(context) {
  return context?.profile
    ? 'NON_RECOMMENDATION_PROFILE_CONSTRAINED_WHAT_IF'
    : 'NON_RECOMMENDATION_WHAT_IF';
}

function assertTargetConcentration(targetAllocation) {
  const grouped = new Map();
  for (const [key, weight] of Object.entries(targetAllocation)) {
    const cap = resolveConcentrationCap({ id: key, type: key, name: key });
    if (cap) grouped.set(cap.key, (grouped.get(cap.key) || 0) + Number(weight));
  }
  for (const [key, total] of grouped.entries()) {
    const sample = Object.keys(targetAllocation).find(id => resolveConcentrationCap({ id, type: id, name: id })?.key === key);
    const cap = resolveConcentrationCap({ id: sample, type: sample, name: sample });
    if (cap && total > cap.maxPct + 0.0001) {
      throw new Error(`${key} allocation exceeds the ${cap.maxPct}% concentration cap`);
    }
  }
}

/**
 * Recursively strips dangerous object keys to prevent prototype pollution.
 */
function sanitizeToolInputs(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeToolInputs);

  const clean = Object.create(null);
  for (const [key, val] of Object.entries(obj)) {
    if (DANGEROUS_OBJECT_KEYS.has(key) || key.startsWith('__')) {
      continue;
    }
    clean[key] = sanitizeToolInputs(val);
  }
  return clean;
}

export class ToolRegistry {
  #tools;
  #sealed = false;

  constructor({ registerCoreTools = true } = {}) {
    this.#tools = new Map();
    if (registerCoreTools) {
      this.registerCoreTools();
      this.seal();
    }
  }

  /**
   * Registers a new financial calculation tool.
   *
   * @param {string} name
   * @param {object} config - { description, schema, executor, version }
   */
  registerTool(name, config) {
    if (this.#sealed) throw new Error('Tool registry is sealed.');
    if (!name || !config.schema || !config.executor) {
      throw new Error(`Invalid tool registration for '${name}'. Schema and executor are required.`);
    }
    if (this.#tools.has(name)) throw new Error(`Tool '${name}' is already registered.`);
    this.#tools.set(name, Object.freeze({
      name,
      description: config.description || '',
      schema: config.schema,
      executor: config.executor,
      version: config.version || '1.0.0',
      // Explicit metadata is required for remote exposure. New tools remain
      // private unless the central allowlist and registry policy both permit it.
      mcpPolicy: config.mcpPolicy || null,
    }));
  }

  seal() {
    this.#sealed = true;
    return this;
  }

  isSealed() {
    return this.#sealed;
  }

  /**
   * Retrieves a tool definition by name.
   */
  getTool(name) {
    return this.#tools.get(name) || null;
  }

  hasTool(name) {
    return this.#tools.has(name);
  }

  /**
   * Returns metadata for all registered tools.
   */
  listTools() {
    return Array.from(this.#tools.values()).map(t => ({
      name: t.name,
      description: t.description,
      version: t.version,
    }));
  }

  listMcpTools({ transport = 'remote' } = {}) {
    return Array.from(this.#tools.values())
      .filter(tool => isMcpToolAllowed(tool, { transport }))
      .map(({ name, description, version, mcpPolicy }) => ({ name, description, version, mcpPolicy }));
  }

  /**
   * Executes a requested tool against canonical backend engine.
   *
   * @param {string} name
   * @param {object} args
   * @param {object} [context={}]
   * @returns {Promise<{ success: boolean, result: any, error?: string, execution_time_ms: number }>}
   */
  async executeTool(name, args = {}, context = {}) {
    const startTime = Date.now();
    const tool = this.getTool(name);

    if (!tool) {
      PrometheusMetrics.recordToolExecution(name, false);
      return {
        success: false,
        error: `Unknown tool requested: '${name}'`,
        result: null,
        execution_time_ms: Date.now() - startTime,
      };
    }

    // Step 1: Deep input sanitization to strip prototype pollution keys & hidden injected fields
    const sanitizedArgs = sanitizeToolInputs(args);

    // Step 2: Validate inputs against tool Joi schema
    const { error, value } = tool.schema.validate(sanitizedArgs, {
      stripUnknown: false,
      allowUnknown: false,
      abortEarly: false,
    });
    if (error) {
      PrometheusMetrics.recordToolExecution(name, false);
      return {
        success: false,
        error: `Invalid tool arguments for '${name}': ${error.details.map(d => d.message).join(', ')}`,
        result: null,
        execution_time_ms: Date.now() - startTime,
      };
    }

    try {
      const result = await tool.executor(value, context);
      PrometheusMetrics.recordToolExecution(name, true);
      return {
        success: true,
        result,
        execution_time_ms: Date.now() - startTime,
      };
    } catch (execErr) {
      if (context?.mcpRequest === true) {
        console.warn('[ToolRegistry] MCP calculator rejected or failed', { tool: name, code: 'MCP_CALCULATION_REJECTED' });
      } else {
        console.error(`[ToolRegistry] Error executing tool '${name}':`, execErr.message);
      }
      PrometheusMetrics.recordToolExecution(name, false);
      return {
        success: false,
        error: `Execution error in '${name}': ${execErr.message}`,
        result: null,
        execution_time_ms: Date.now() - startTime,
      };
    }
  }

  registerCoreTools() {
    // 1. SIP Projection Tool
    this.registerTool('sip_projection', {
      mcpPolicy: MCP_TOOL_POLICY.sip_projection,
      description: 'Calculates Future Value of a Systematic Investment Plan (SIP) using monthly annuity-due compounding.',
      version: '2.1.0',
      schema: Joi.object({
        monthlyInvestment: Joi.number().min(100).max(10000000).required(),
        annualRate: Joi.number().min(0.001).max(0.50).required(), // decimal, e.g. 0.12 for 12%
        years: Joi.number().min(1).max(50).required(),
      }),
      executor: async ({ monthlyInvestment, annualRate, years }, context) => {
        assertProjectionWithinProfile(context, { monthlyInvestment, years });
        const futureValue = sipFV(monthlyInvestment, annualRate, years);
        const totalInvested = monthlyInvestment * years * 12;
        const totalReturns = futureValue - totalInvested;
        return {
          monthlyInvestment,
          annualRatePct: annualRate * 100,
          years,
          totalInvested: Math.round(totalInvested),
          futureValue: Math.round(futureValue),
          totalReturns: Math.round(totalReturns),
          classification: calculationClassification(context),
          returnBasis: 'USER_SUPPLIED_NOMINAL_ASSUMPTION',
        };
      },
    });

    // 2. Lump Sum Projection Tool
    this.registerTool('lump_sum_projection', {
      mcpPolicy: MCP_TOOL_POLICY.lump_sum_projection,
      description: 'Calculates Future Value of a one-time lump sum investment using compound interest.',
      version: '2.1.0',
      schema: Joi.object({
        principal: Joi.number().min(1000).max(1000000000).required(),
        annualRate: Joi.number().min(0.001).max(0.50).required(),
        years: Joi.number().min(1).max(50).required(),
      }),
      executor: async ({ principal, annualRate, years }, context) => {
        assertProjectionWithinProfile(context, { principal, years });
        const futureValue = lumpSumFV(principal, annualRate, years);
        const totalReturns = futureValue - principal;
        return {
          principal,
          annualRatePct: annualRate * 100,
          years,
          futureValue: Math.round(futureValue),
          totalReturns: Math.round(totalReturns),
          classification: calculationClassification(context),
          returnBasis: 'USER_SUPPLIED_NOMINAL_ASSUMPTION',
        };
      },
    });

    // 3. Reverse SIP Planner Tool
    this.registerTool('reverse_sip', {
      mcpPolicy: MCP_TOOL_POLICY.reverse_sip,
      description: 'Calculates required monthly SIP to achieve a target financial goal.',
      version: '2.2.0',
      schema: Joi.object({
        targetAmount: Joi.number().min(1000).max(10000000000).required(),
        annualRate: Joi.number().min(0.001).max(0.50).required(),
        years: Joi.number().min(1).max(50).required(),
        currentSavings: Joi.number().min(0).max(10000000000).required(),
      }),
      executor: async ({ targetAmount, annualRate, years, currentSavings }) => {
        // Invert the same nominal-rate SIP and annual lump-sum projections
        // exposed by the paired registry tools. Monte Carlo goal planning uses
        // a distinct effective-annual assumption and must not be mixed here.
        const remainingTarget = Math.max(0, targetAmount - lumpSumFV(currentSavings, annualRate, years));
        const requiredMonthlySip = remainingTarget === 0
          ? 0
          : reverseSIPFromFV(remainingTarget, annualRate, years);
        return {
          targetAmount,
          annualRatePct: annualRate * 100,
          years,
          currentSavings,
          requiredMonthlySip: Math.round(requiredMonthlySip),
          classification: 'NON_RECOMMENDATION_GOAL_WHAT_IF',
          returnBasis: 'USER_SUPPLIED_NOMINAL_ASSUMPTION',
        };
      },
    });

    // 4. Tax Calculator Tool
    this.registerTool('tax_calculator', {
      mcpPolicy: MCP_TOOL_POLICY.tax_calculator,
      description: 'Computes income tax liability under an explicitly selected supported fiscal-year policy.',
      version: '2.2.0',
      schema: Joi.object({
        income: Joi.number().min(0).max(1000000000).required(),
        basicSalary: Joi.number().min(0).max(1000000000).optional(),
        incomeSource: Joi.string().valid('salary', 'pension', 'family_pension', 'business', 'other').required(),
        fiscalYear: Joi.string().valid('FY2025-26', 'FY2026-27').required(),
        age: Joi.number().integer().min(18).max(120).required(),
        regime: Joi.string().valid('new').required(),
        section80C: Joi.number().min(0).max(150000).required(),
        nps80CCD1B: Joi.number().min(0).max(50000).required(),
        section80D_self: Joi.number().min(0).max(50000).required(),
        section80D_parents: Joi.number().min(0).max(50000).required(),
        parentsSenior: Joi.boolean().required(),
        hra: Joi.number().min(0).max(100000000).required(),
      }),
      executor: async ({ income, basicSalary, incomeSource, fiscalYear, age, regime, section80C, nps80CCD1B, section80D_self, section80D_parents, parentsSenior, hra }) => {
        const deductions = {
          basicSalary, age, section80C, nps80CCD1B, section80D_self,
          section80D_parents, parents_senior: parentsSenior, hra,
        };
        const taxResult = computeTax(income, regime, deductions, incomeSource, fiscalYear);
        return { ...taxResult, classification: 'SEPARATE_TAX_WHAT_IF' };
      },
    });

    // 5. XIRR Calculator Tool
    this.registerTool('xirr_calculator', {
      mcpPolicy: MCP_TOOL_POLICY.xirr_calculator,
      description: 'Calculates Exact Internal Rate of Return (XIRR) for irregular cash flows.',
      version: '2.1.0',
      schema: Joi.object({
        cashflows: Joi.array().items(
          Joi.object({
            amount: Joi.number().min(-1000000000000).max(1000000000000).required(),
            date: Joi.string().max(10).pattern(/^\d{4}-\d{2}-\d{2}$/).custom(validateIsoCalendarDate).required(),
          })
        ).min(2).max(600).required(),
      }),
      executor: async ({ cashflows }) => {
        return { ...computeXIRR(cashflows), classification: 'HISTORICAL_RETURN_CALCULATION' };
      },
    });

    // 6. Portfolio Optimizer Tool
    this.registerTool('portfolio_optimizer', {
      mcpPolicy: MCP_TOOL_POLICY.portfolio_optimizer,
      description: 'Optimizes asset weights for minimum variance, maximum Sharpe ratio, or risk parity.',
      version: '2.1.0',
      schema: Joi.object({
        strategy: Joi.string().valid('min_variance', 'max_sharpe', 'risk_parity').required(),
        assets: Joi.array().items(Joi.string().valid(...VALID_ASSET_KEYS)).min(2).max(10).unique().required(),
      }),
      executor: async ({ strategy, assets }, context) => {
        const profile = canonicalContextProfile(context);
        if (profile) assertPortfolioSuitable(profile, assets);
        const nominalReturns = assets.map(asset => INSTRUMENT_PARAMS[asset].nominalRate / 100);

        let result;
        if (strategy === 'max_sharpe') {
          result = solveMaxSharpe(assets, nominalReturns);
        } else if (strategy === 'risk_parity') {
          result = solveRiskParity(assets, nominalReturns);
        } else {
          result = solveMinVariance(assets, nominalReturns);
        }
        const capped = enforceAllocationTargets(assets.map(asset => ({
          id: asset, type: asset, name: INSTRUMENT_PARAMS[asset].name,
          score: Number(result.weights[asset]) * 100,
        })));
        const finalWeights = Object.fromEntries(capped.map(asset => [asset.id, asset.allocationWeight]));
        const metrics = evaluatePortfolio(assets, nominalReturns, finalWeights);
        return {
          strategy,
          weights: finalWeights,
          ...metrics,
          classification: calculationClassification(context),
          returnBasis: 'PRE_TAX_NOMINAL',
        };
      },
    });

    // 7. Portfolio Rebalance Tool
    this.registerTool('rebalance_calculator', {
      mcpPolicy: MCP_TOOL_POLICY.rebalance_calculator,
      description: 'Computes portfolio drift and rebalance buy/sell directives.',
      version: '2.1.0',
      schema: Joi.object({
        current_allocation: Joi.object().pattern(SAFE_ALLOCATION_KEY_REGEX, Joi.number().min(0)).required(),
        target_allocation: Joi.object().pattern(SAFE_ALLOCATION_KEY_REGEX, Joi.number().min(0).max(100)).required(),
        threshold: Joi.number().min(0).max(50).required(),
        partial_ratio: Joi.number().min(0.1).max(1).required(),
        holding_months: Joi.number().min(0).max(600).required(),
      }),
      executor: async ({ current_allocation, target_allocation, threshold, partial_ratio, holding_months }, context) => {
        const profile = canonicalContextProfile(context);
        if (profile) {
          assertPortfolioSuitable(profile, Object.entries(target_allocation).filter(([, value]) => value > 0).map(([key]) => key));
          assertTargetConcentration(target_allocation);
        }
        const total = Object.values(target_allocation).reduce((sum, weight) => sum + weight, 0);
        if (Math.abs(total - 100) > 0.01) throw new Error('target_allocation must sum to exactly 100');
        return {
          ...computeRebalance(current_allocation, target_allocation, threshold, partial_ratio, holding_months),
          classification: calculationClassification(context),
          assumptions: { threshold, partial_ratio, holding_months },
        };
      },
    });
  }
}

export const FinancialToolRegistry = Object.freeze(new ToolRegistry());
export function createIsolatedToolRegistry() {
  return new ToolRegistry({ registerCoreTools: false });
}
