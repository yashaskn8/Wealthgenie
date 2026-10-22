import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const masterCatalog = JSON.parse(readFileSync(resolve(here, '../data/investment_master.json'), 'utf8'));
const universeTaxonomy = JSON.parse(readFileSync(resolve(here, '../data/investment_universe_taxonomy.json'), 'utf8'));

const LEGACY_CATEGORY_TO_UNIVERSE_CATEGORY = Object.freeze({
  'Bank Deposits': 'bank-savings-and-deposits',
  Government: 'government-and-post-office-savings',
  'Debt Mutual Funds': 'mutual-funds',
  'Equity Mutual Funds': 'mutual-funds',
  ETFs: 'exchange-traded-products',
  'Direct Equity': 'listed-equities',
  Retirement: 'retirement-and-pension',
  Gold: 'gold-silver-and-commodities',
  'REITs & InvITs': 'real-estate-and-infrastructure',
  'Bonds & Debentures': 'corporate-fixed-income',
  'Insurance-linked': 'insurance-linked-savings',
  Other: 'alternative-and-specialized-investments',
});

// These are explicit corrections for catalog IDs whose original broad bucket
// combines unrelated product families. This mapping assigns taxonomy only; it
// does not assert a current product identity or any financial fact.
const LEGACY_ID_CATEGORY_OVERRIDES = Object.freeze({
  po_rd: 'government-and-post-office-savings',
  po_td_1yr: 'government-and-post-office-savings',
  bharat_bond_direct: 'mutual-funds',
  rbi_bonds: 'government-debt-securities',
  rbi_retail_direct_gilt: 'government-debt-securities',
  treasury_bills: 'government-debt-securities',
  g_sec: 'government-debt-securities',
  bonds_54ec: 'corporate-fixed-income',
  sgb: 'government-debt-securities',
  sgb_secondary: 'government-debt-securities',
  pre_ipo_unlisted_shares: 'alternative-and-specialized-investments',
  commodity_futures: 'alternative-and-specialized-investments',
  digital_gold: 'alternative-and-specialized-investments',
  direct_us_stocks_megacap: 'alternative-and-specialized-investments',
});

const LEGACY_ID_REVIEW_FLAGS = Object.freeze({
  term_mf_combo: 'CLASSIFICATION_REVIEW_REQUIRED',
  futures_and_options: 'RESTRICTED_HIGH_RISK_REVIEW',
  crypto_vda: 'RESTRICTED_LEGAL_STATUS_REVIEW',
  commodity_futures: 'RESTRICTED_HIGH_RISK_REVIEW',
  digital_gold: 'REGULATORY_AND_COUNTERPARTY_REVIEW_REQUIRED',
  p2p_lending: 'REGULATORY_AND_ELIGIBILITY_REVIEW',
  pre_ipo_unlisted_shares: 'ELIGIBILITY_AND_LIQUIDITY_REVIEW',
  direct_us_stocks_megacap: 'FOREIGN_INVESTMENT_CHANNEL_REVIEW_REQUIRED',
  bharat_bond_direct: 'PRODUCT_FORM_REVIEW_REQUIRED',
});

const TAXONOMY_CATEGORY_IDS = new Set(universeTaxonomy.categories.map(category => category.id));
const categoryById = new Map(universeTaxonomy.categories.map(category => [category.id, category]));

function subcategoryIdFor(label) {
  const slug = String(label).toLocaleLowerCase('en-IN')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return slug;
}

// Explicit mappings from the old family catalog. This describes the broad
// investment family only; it does not establish issuer terms or a live product.
const LEGACY_ID_SUBCATEGORY_NAMES = Object.freeze({
  ppf: 'Public Provident Fund (PPF)',
  scss: 'Senior Citizens Savings Scheme (SCSS)',
  sukanya: 'Sukanya Samriddhi Yojana',
  rbi_bonds: 'RBI Floating Rate Savings Bonds',
  sgb: 'Sovereign Gold Bonds — primary issuance',
  sgb_secondary: 'Sovereign Gold Bonds — secondary-market instruments',
  nsc: 'National Savings Certificate (NSC)',
  kvp: 'Kisan Vikas Patra (KVP)',
  pomis: 'Post Office Monthly Income Scheme',
  mssc: 'Other central or state-backed retail savings products',
  apy: 'Atal Pension Yojana',
  fd: 'Fixed deposits — issuer and payout terms unverified',
  sbi_fd: 'Fixed deposits — issuer and payout terms unverified',
  hdfc_fd: 'Fixed deposits — issuer and payout terms unverified',
  icici_fd: 'Fixed deposits — issuer and payout terms unverified',
  axis_fd: 'Fixed deposits — issuer and payout terms unverified',
  kotak_fd: 'Fixed deposits — issuer and payout terms unverified',
  indusind_fd: 'Fixed deposits — issuer and payout terms unverified',
  idfc_fd: 'Fixed deposits — issuer and payout terms unverified',
  au_sfb_fd: 'Fixed deposits — issuer and payout terms unverified',
  ujjivan_fd: 'Fixed deposits — issuer and payout terms unverified',
  equitas_fd: 'Fixed deposits — issuer and payout terms unverified',
  canara_fd: 'Fixed deposits — issuer and payout terms unverified',
  pnb_fd: 'Fixed deposits — issuer and payout terms unverified',
  bob_fd: 'Fixed deposits — issuer and payout terms unverified',
  bajaj_finance_fd: 'NBFC and company fixed deposits',
  shriram_finance_fd: 'NBFC and company fixed deposits',
  lic_housing_fd: 'NBFC and company fixed deposits',
  pnb_housing_fd: 'NBFC and company fixed deposits',
  mahindra_finance_fd: 'NBFC and company fixed deposits',
  jana_sfb_fd: 'Small-finance-bank deposits',
  suryoday_sfb_fd: 'Small-finance-bank deposits',
  esaf_sfb_fd: 'Small-finance-bank deposits',
  utkarsh_sfb_fd: 'Small-finance-bank deposits',
  po_rd: 'Post Office Recurring Deposit',
  po_td_1yr: 'Post Office Time Deposits',
  liquid_mf: 'Liquid funds',
  overnight_mf: 'Overnight funds',
  ultra_short_mf: 'Ultra-short-duration and low-duration funds',
  low_duration_mf: 'Ultra-short-duration and low-duration funds',
  money_market_mf: 'Money-market funds',
  debt_mf: 'Other debt funds',
  short_duration_mf: 'Other debt funds',
  medium_duration_mf: 'Other debt funds',
  corporate_bond_mf: 'Corporate-bond funds',
  banking_psu_mf: 'Banking and PSU funds',
  dynamic_bond_mf: 'Other debt funds',
  gilt_mf: 'Gilt funds',
  floater_mf: 'Floating-rate debt funds',
  floating_rate_debt_mf: 'Floating-rate debt funds',
  credit_risk_mf: 'Credit-risk funds',
  index_mf: 'Index funds',
  elss: 'Equity Linked Savings Schemes (ELSS)',
  midcap_mf: 'Mid-cap funds',
  smallcap_mf: 'Small-cap funds',
  hybrid_mf: 'Balanced-advantage funds',
  large_cap_mf: 'Large-cap funds',
  large_mid_mf: 'Large-and-mid-cap funds',
  flexi_cap_mf: 'Flexi-cap funds',
  multi_cap_mf: 'Multi-cap funds',
  focused_mf: 'Focused funds',
  value_mf: 'Value funds',
  contra_mf: 'Contra funds',
  dividend_yield_mf: 'Other current SEBI-defined scheme categories',
  agg_hybrid_mf: 'Hybrid funds',
  conservative_hybrid_mf: 'Hybrid funds',
  equity_savings_mf: 'Hybrid funds',
  multi_asset_allocation_mf: 'Multi-asset funds',
  mfg_sector_mf: 'Sectoral and thematic funds',
  infra_sector_mf: 'Sectoral and thematic funds',
  pharma_sector_mf: 'Sectoral and thematic funds',
  banking_sector_mf: 'Sectoral and thematic funds',
  it_sector_mf: 'Sectoral and thematic funds',
  consumption_mf: 'Sectoral and thematic funds',
  esg_mf: 'Sectoral and thematic funds',
  defence_sector_mf: 'Sectoral and thematic funds',
  psu_sector_mf: 'Sectoral and thematic funds',
  auto_sector_mf: 'Sectoral and thematic funds',
  fmcg_sector_mf: 'Sectoral and thematic funds',
  arbitrage_mf: 'Arbitrage funds',
  fixed_maturity_plan: 'Other debt funds',
  children_solution_fund: 'Children solution-oriented schemes',
  retirement_solution_fund: 'Retirement solution-oriented schemes',
  motilal_nasdaq100_fof: 'Fund-of-funds',
  mirae_nyse_fang_etf_fof: 'Fund-of-funds',
  edelweiss_greater_china_fof: 'Fund-of-funds',
  kotak_nasdaq100_fof: 'Fund-of-funds',
  edelweiss_us_tech_fof: 'Fund-of-funds',
  icici_us_bluechip_fund: 'International funds',
  franklin_us_opportunities: 'International funds',
  dsp_us_flexible_equity: 'International funds',
  us_equity_mf: 'International funds',
  global_equity_mf: 'International funds',
  motilal_sp500_index: 'Index funds',
  value_factor_mf: 'Index funds',
  parag_parikh_flexi: 'Flexi-cap funds',
  sbi_bluechip: 'Large-cap funds',
  hdfc_midcap: 'Mid-cap funds',
  mirae_elss: 'Equity Linked Savings Schemes (ELSS)',
  nifty_etf: 'Broad-market equity ETFs',
  sensex_etf: 'Broad-market equity ETFs',
  nifty_next_etf: 'Broad-market equity ETFs',
  midcap_etf: 'Broad-market equity ETFs',
  bank_etf: 'Sectoral ETFs',
  it_etf: 'Sectoral ETFs',
  cpse_etf: 'Sectoral ETFs',
  momentum_factor_etf: 'Factor and smart-beta ETFs',
  bharat_bond_2030: 'Debt ETFs',
  liquid_etf: 'Liquid ETFs',
  silver_etf: 'Silver ETFs and funds',
  gold_etf: 'Gold ETFs and funds',
  gold_mf: 'Gold ETFs and funds',
  nasdaq_etf: 'International ETFs',
  sp500_etf: 'International ETFs',
  motilal_nasdaq_q50_etf: 'International ETFs',
  us_sp500_etf_lrs: 'International ETFs',
  us_nasdaq100_etf_lrs: 'International ETFs',
  us_dividend_etf_lrs: 'International ETFs',
  us_global_total_world_etf_lrs: 'International ETFs',
  bluechip_stocks: 'Large-cap companies',
  large_cap_stocks: 'Large-cap companies',
  mid_cap_stocks: 'Mid-cap companies',
  small_cap_stocks: 'Small-cap companies',
  direct_equity: 'Other eligible listed equity products',
  smallcase_thematic: 'Other eligible listed equity products',
  nps: 'NPS Tier I',
  nps_tier_2: 'NPS Tier II',
  epf: 'EPF and VPF accumulation',
  vpf: 'EPF and VPF accumulation',
  embassy_reit: 'Listed REITs',
  mindspace_reit: 'Listed REITs',
  brookfield_reit: 'Listed REITs',
  nexus_reit: 'Listed REITs',
  indigrid_invit: 'Listed InvITs',
  powergrid_invit: 'Listed InvITs',
  infrastructure_invit: 'Listed InvITs',
  ulip: 'Unit-linked insurance plans (ULIPs)',
  endowment_plan: 'Endowment policies',
  term_mf_combo: 'Other insurance-linked savings products',
  g_sec: 'Central Government Securities',
  treasury_bills: 'Treasury Bills',
  rbi_retail_direct_gilt: 'RBI Retail Direct securities',
  municipal_bonds: 'Municipal bonds',
  aaa_corporate_bond: 'Corporate bonds',
  aa_corporate_bond: 'Corporate bonds',
  tax_free_bonds: 'Tax-free bonds with existing tradable issues',
  bonds_54ec: 'PSU bonds',
  bharat_bond_direct: 'Fund-of-funds',
  p2p_lending: 'Regulated P2P lending exposure',
  pre_ipo_unlisted_shares: 'Regulated private-market opportunities',
  crypto_vda: 'Virtual digital assets — restricted review category',
  futures_and_options: 'Derivatives and speculative leveraged products — restricted review category',
  commodity_futures: 'Derivatives and speculative leveraged products — restricted review category',
  digital_gold: 'Unregulated offerings — excluded from ordinary investment recommendations',
  direct_us_stocks_megacap: 'Foreign securities and funds through lawful Indian channels',
});

function categoryForLegacyItem(item) {
  return LEGACY_ID_CATEGORY_OVERRIDES[item.id]
    || LEGACY_CATEGORY_TO_UNIVERSE_CATEGORY[item.category]
    || null;
}

function subcategoryForLegacyItem(item, categoryId) {
  const label = LEGACY_ID_SUBCATEGORY_NAMES[item.id];
  if (!label || !categoryId) return null;
  const category = categoryById.get(categoryId);
  if (!category?.subcategories.includes(label)) return null;
  return { id: subcategoryIdFor(label), name: label };
}

function toFamilyRecord(item) {
  const categoryId = categoryForLegacyItem(item);
  const subcategory = subcategoryForLegacyItem(item, categoryId);
  return {
    id: `legacy-family:${item.id}`,
    legacyCatalogId: item.id,
    name: item.name,
    legacyCategory: item.category,
    assetClassLabel: item.assetClass || null,
    catalogLevel: 'PRODUCT_FAMILY',
    categoryId: categoryId && TAXONOMY_CATEGORY_IDS.has(categoryId) ? categoryId : null,
    subcategoryId: subcategory?.id || null,
    subcategoryName: subcategory?.name || null,
    classificationStatus: LEGACY_ID_REVIEW_FLAGS[item.id] || 'FAMILY_CLASSIFICATION_ONLY',
    lifecycleStatus: 'NOT_VERIFIED',
    source: {
      provider: 'WEALTHGENIE_LEGACY_FAMILY_CATALOG',
      catalogVersion: masterCatalog.catalogVersion,
      lastCatalogGenerationAt: masterCatalog.generatedAt,
    },
    currentFacts: {
      price: { status: 'NOT_LOADED', value: null },
      nav: { status: 'NOT_LOADED', value: null },
      rate: { status: 'NOT_LOADED', value: null },
      historicalPerformance: { status: 'NOT_LOADED', value: null },
      fees: { status: 'NOT_LOADED', value: null },
      taxTreatment: { status: 'NOT_VERIFIED', value: null },
      eligibility: { status: 'NOT_VERIFIED', value: null },
      liquidity: { status: 'NOT_VERIFIED', value: null },
    },
  };
}

const familyRecords = Object.freeze(masterCatalog.instruments.map(toFamilyRecord));

function categoryCounts(families = familyRecords) {
  const counts = new Map();
  for (const family of families) {
    if (!family.categoryId) continue;
    counts.set(family.categoryId, (counts.get(family.categoryId) || 0) + 1);
  }
  return counts;
}

export function getInvestmentExplorerTaxonomy() {
  const counts = categoryCounts();
  return {
    schemaVersion: universeTaxonomy.schemaVersion,
    catalogLevel: universeTaxonomy.catalogLevel,
    currentProductAvailability: universeTaxonomy.currentProductAvailability,
    sourceRightsPolicy: 'Numeric facts are excluded until each source is qualified for access, storage, calculation, display, and the applicable use.',
    categories: universeTaxonomy.categories.map(category => ({
      ...category,
      subcategories: category.subcategories.map(name => ({
        id: subcategoryIdFor(name),
        name,
      })),
      currentProductFamilyCount: counts.get(category.id) || 0,
    })),
    unclassifiedLegacyFamilyCount: familyRecords.filter(family => !family.categoryId).length,
  };
}

export function searchInvestmentExplorerCatalog({
  q = '',
  categoryId = null,
  subcategoryId = null,
  page = 1,
  limit = 24,
} = {}) {
  const normalizedQuery = String(q).trim().toLocaleLowerCase('en-IN');
  const filtered = familyRecords.filter(family => {
    if (categoryId && family.categoryId !== categoryId) return false;
    if (subcategoryId && family.subcategoryId !== subcategoryId) return false;
    if (normalizedQuery && !`${family.name} ${family.legacyCatalogId} ${family.legacyCategory} ${family.assetClassLabel || ''}`
      .toLocaleLowerCase('en-IN').includes(normalizedQuery)) return false;
    return true;
  }).sort((left, right) => left.name.localeCompare(right.name, 'en-IN'));
  const safePage = Number.isInteger(Number(page)) && Number(page) > 0 ? Number(page) : 1;
  const safeLimit = Number.isInteger(Number(limit)) && Number(limit) > 0 ? Math.min(100, Number(limit)) : 24;
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / safeLimit));
  const currentPage = Math.min(safePage, pages);
  const offset = (currentPage - 1) * safeLimit;

  return {
    schemaVersion: universeTaxonomy.schemaVersion,
    catalog: {
      source: 'WEALTHGENIE_LEGACY_FAMILY_CATALOG',
      sourceVersion: masterCatalog.catalogVersion,
      catalogLevel: 'PRODUCT_FAMILY',
      totalFamilyRecords: familyRecords.length,
      currentProductFactsIncluded: false,
    },
    filters: {
      q: String(q).trim(),
      categoryId,
      subcategoryId,
    },
    pagination: {
      page: currentPage,
      pageSize: safeLimit,
      total,
      pages,
    },
    products: filtered.slice(offset, offset + safeLimit),
  };
}

export const investmentExplorerTestExports = Object.freeze({
  familyRecords,
  universeTaxonomy,
  LEGACY_ID_CATEGORY_OVERRIDES,
  LEGACY_ID_SUBCATEGORY_NAMES,
});
