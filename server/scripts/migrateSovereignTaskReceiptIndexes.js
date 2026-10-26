import mongoose from 'mongoose';
import SovereignTaskReceipt from '../models/SovereignTaskReceipt.js';
import { verifyPersistenceIndexes } from '../services/persistenceIndexReadiness.js';
import { hasSovereignReceiptTtlIndex } from '../services/sovereignTaskReceiptStore.js';

const uri=String(process.env.MONGODB_MIGRATION_URI||'').trim();
if(!uri)throw new Error('MONGODB_MIGRATION_URI is required for Sovereign task receipts.');
try{
  await mongoose.connect(uri,{autoIndex:false});
  await SovereignTaskReceipt.createIndexes();
  await verifyPersistenceIndexes({models:[SovereignTaskReceipt],scope:'persistence',force:true});
  const indexes=await SovereignTaskReceipt.collection.indexes();
  if(!hasSovereignReceiptTtlIndex(indexes))
    throw new Error('Sovereign task receipt TTL index is missing.');
  process.stdout.write('Sovereign task receipt indexes verified.\n');
}catch(error){
  process.stderr.write('Sovereign task receipt migration failed: '+(error.code||error.name)+'\n');
  process.exitCode=1;
}finally{
  await mongoose.disconnect();
}
