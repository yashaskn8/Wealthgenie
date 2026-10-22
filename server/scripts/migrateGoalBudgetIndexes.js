import mongoose from 'mongoose';
import GoalBudget from '../models/GoalBudget.js';

const uri = String(process.env.MONGODB_MIGRATION_URI || '').trim();
if (!uri) throw new Error('MONGODB_MIGRATION_URI is required for the explicit Goals budget index migration');

try {
  await mongoose.connect(uri, { autoIndex: false });
  await GoalBudget.collection.createIndex({ userId: 1, month: 1 }, {
    unique: true, name: 'goal_budget_owner_month_unique',
  });
  const indexes = await GoalBudget.collection.indexes();
  const ready = indexes.some(index => index.name === 'goal_budget_owner_month_unique'
    && index.unique === true && index.key.userId === 1 && index.key.month === 1);
  if (!ready) throw new Error('Required owner/month unique index was not verified');
  process.stdout.write('Goals budget owner/month index verified.\n');
} catch (error) {
  process.stderr.write(`Goals budget migration failed: ${error.code || error.name || 'UNKNOWN'}\n`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
