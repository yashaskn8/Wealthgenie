import mongoose from 'mongoose';
import { GOAL_EXPENSE_CATEGORIES } from '../services/goalFinanceEngine.js';

const expenseSchema = new mongoose.Schema({
  category: { type: String, enum: GOAL_EXPENSE_CATEGORIES, required: true },
  frequency: { type: String, enum: ['recurring', 'one_off'], required: true },
  amount: { type: Number, required: true, min: 0, max: 1_000_000_000 },
}, { _id: false, strict: 'throw' });

const goalBudgetSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true, ref: 'User' },
  month: { type: String, required: true, immutable: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
  version: { type: Number, required: true, default: 1, min: 1 },
  monthlyIncome: { type: Number, default: null, min: 0, max: 1_000_000_000 },
  expensesComplete: { type: Boolean, required: true, default: false },
  protectedMonthlyContributions: { type: Number, default: 0, min: 0, max: 1_000_000_000 },
  expenses: { type: [expenseSchema], required: true, default: [] },
}, { timestamps: true, strict: 'throw', optimisticConcurrency: true });

goalBudgetSchema.index({ userId: 1, month: 1 }, { unique: true });
export default mongoose.model('GoalBudget', goalBudgetSchema);
