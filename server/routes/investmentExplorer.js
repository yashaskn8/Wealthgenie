import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { validateQuery, investmentExplorerQuerySchema } from '../validation/schemas.js';
import {
  getInvestmentExplorerTaxonomy,
  searchInvestmentExplorerCatalog,
} from '../services/investmentExplorerCatalog.js';

const router = Router();

// The discovery taxonomy and legacy product-family identities are public
// catalog metadata. They contain no user profile, recommendation, or live fact.
router.get('/taxonomy', asyncHandler(async (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=300');
  res.json(getInvestmentExplorerTaxonomy());
}));

router.get('/catalog', validateQuery(investmentExplorerQuerySchema), asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
  res.json(searchInvestmentExplorerCatalog({
    q: req.query.q || '',
    categoryId: req.query.categoryId || null,
    subcategoryId: req.query.subcategoryId || null,
    page: Number(req.query.page || 1),
    limit: Number(req.query.limit || 24),
  }));
}));

export default router;
