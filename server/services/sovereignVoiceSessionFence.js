import mongoose from 'mongoose';
import User from '../models/User.js';
import { isTokenBlacklisted } from '../config/redis.js';
import { createError } from '../middleware/errorHandler.js';

const denied=()=>createError(401,'The authenticated session changed.',
  'Sign in again before reviewing a voice task result.',{code:'VOICE_SESSION_REVOKED'});
const unavailable=()=>createError(503,'Current session validity is unavailable.',
  'The task result was withheld until session access can be verified.',
  {code:'VOICE_SESSION_STATE_UNAVAILABLE'});

/**
 * Re-check an already-authenticated session immediately before publishing
 * read-only financial data or a task receipt. The initial JWT middleware
 * validates the signature; this fence catches mid-request logout, deletion,
 * expiry and revocation-store outages.
 */
export async function assertSovereignVoiceSessionCurrent(user,{
  now=Date.now,
  isDatabaseReady=()=>mongoose.connection.readyState===1,
  loadAccount=userId=>User.findById(userId).select('role').lean(),
  checkRevocation=isTokenBlacklisted,
  timeoutMs=5_000,
  signal
}={}) {
  if(!user || !mongoose.isValidObjectId(user.userId) ||
      !Number.isSafeInteger(user.exp) || user.exp*1000<=now() ||
      (process.env.NODE_ENV==='production' && !user.jti))throw denied();
  if(signal?.aborted)throw denied();
  if(!isDatabaseReady())throw unavailable();
  let deadlineHandle;
  let onAbort;
  // Account and revocation stores are read-only but may hang on network faults.
  const deadline=new Promise((_,reject)=>{
    deadlineHandle=setTimeout(()=>reject(unavailable()),timeoutMs);
    if(signal){
      onAbort=()=>reject(denied());
      signal.addEventListener('abort',onAbort,{once:true});
      if(signal.aborted)onAbort();
    }
  });
  try {
    const [account,revoked]=await Promise.race([
      Promise.all([
        loadAccount(user.userId),
        user.jti?checkRevocation(user.jti):false
      ]),deadline
    ]);
    if(!account||revoked)throw denied();
  }catch(cause){
    if(cause?.code==='VOICE_SESSION_REVOKED')throw cause;
    throw unavailable();
  }finally{
    clearTimeout(deadlineHandle);
    if(onAbort)signal.removeEventListener('abort',onAbort);
  }
  if(signal?.aborted || user.exp*1000<=now())throw denied();
}
