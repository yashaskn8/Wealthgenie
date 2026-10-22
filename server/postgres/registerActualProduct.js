/**
 * Transactional promotion of a REAL source-identified financial instrument.
 * An archetype, ticker name or investment category is not a tradeable issue.
 * Neither this function nor the caller can approve advisory suitability.
 */
function bad(code){const e=new Error(code);e.code=code;return e;}
function safeId(value,max=160){
 return typeof value==='string'&&value.length>=1&&value.length<=max
   &&/^[a-zA-Z0-9:_-]+$/.test(value);
}
export async function registerQualifiedActualProduct(pool,{
 productId,productName,categoryId,subcategoryId=null,sourceId,
 sourceInstrumentId,evidenceUrl,reviewedAt=new Date(),
}={}){
 if(!pool||typeof pool.connect!=='function')throw bad('POSTGRES_POOL_REQUIRED');
 if(!safeId(productId)||!safeId(sourceId)||!safeId(categoryId)
   ||(subcategoryId!==null&&!safeId(subcategoryId))
   ||typeof sourceInstrumentId!=='string'||sourceInstrumentId.length<1
   ||sourceInstrumentId.length>255||/[\x00-\x1f\x7f]/.test(sourceInstrumentId)
   ||typeof productName!=='string'||productName.trim().length<3||productName.length>255
   ||!(reviewedAt instanceof Date)||!Number.isFinite(+reviewedAt)
   ||reviewedAt>new Date()){
  throw bad('INVALID_ACTUAL_PRODUCT_IDENTITY_OR_REVIEW');
 }
 let parsed;
 try{parsed=new URL(evidenceUrl);}catch{throw bad('ACTUAL_PRODUCT_EVIDENCE_URL_REQUIRED');}
 if(parsed.protocol!=='https:'||parsed.username||parsed.password)
   throw bad('ACTUAL_PRODUCT_EVIDENCE_URL_REQUIRED');
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const rights=await client.query(`
    SELECT source_id FROM finance.provider_rights
     WHERE source_id=$1 AND access_allowed AND extraction_allowed
       AND storage_allowed AND derivation_allowed
       AND public_display_allowed AND commercial_use_allowed
       AND redistribution_allowed
       AND reviewed_at IS NOT NULL AND revoked_at IS NULL
       AND retention_seconds IS NOT NULL AND retention_seconds>0
       AND (expires_at IS NULL OR expires_at>now())
     FOR SHARE`,[sourceId]);
  if(rights.rows.length!==1)throw bad('ACTUAL_PRODUCT_SOURCE_RIGHTS_UNQUALIFIED');
  const cat=await client.query(`
    SELECT id FROM finance.categories WHERE id=$1 AND status='ACTIVE'
  `,[categoryId]);
  if(cat.rows.length!==1)throw bad('ACTUAL_PRODUCT_CATEGORY_NOT_VERIFIED');
  if(subcategoryId!==null){
    const sub=await client.query(`
      SELECT id FROM finance.subcategories WHERE id=$1 AND category_id=$2
    `,[subcategoryId,categoryId]);
    if(sub.rows.length!==1)throw bad('ACTUAL_PRODUCT_SUBCATEGORY_MISMATCH');
  }
  // Immutable imported identity: another provider cannot silently seize an ID.
  const prior=await client.query(`
    SELECT id,name,record_kind,category_id,subcategory_id,source_identity,
           discovery_reference_url,verification_scope
      FROM finance.products WHERE id=$1 FOR UPDATE`,[productId]);
  const externalIdentity=sourceId+':'+sourceInstrumentId;
  let inserted=false;
  if(prior.rows.length){
    const p=prior.rows[0];
    if(p.record_kind!=='ACTUAL_PRODUCT'||p.name!==productName.trim()
       ||p.category_id!==categoryId||p.subcategory_id!==subcategoryId
       ||p.source_identity!==externalIdentity
       ||p.discovery_reference_url!==evidenceUrl
       ||p.verification_scope!=='VERIFIED_ACTUAL_PRODUCT')
      throw bad('ACTUAL_PRODUCT_IDENTITY_CONFLICT');
  } else{
    await client.query(`
      INSERT INTO finance.products
        (id,name,record_kind,category_id,subcategory_id,source_identity,
         availability,recommendation_eligible,
         discovery_reference_url,verification_scope,assessed_as_of)
      VALUES($1,$2,'ACTUAL_PRODUCT',$3,$4,$5,
             'AVAILABLE',false,$6,'VERIFIED_ACTUAL_PRODUCT',$7)`,
      [productId,productName.trim(),categoryId,subcategoryId,
        externalIdentity,evidenceUrl,reviewedAt.toISOString().slice(0,10)]);
    inserted=true;
  }
  await client.query(`
    INSERT INTO finance.product_external_ids
      (product_id,source_id,source_instrument_id)
    VALUES($1,$2,$3) ON CONFLICT(product_id,source_id,source_instrument_id)
    DO NOTHING`,[productId,sourceId,sourceInstrumentId]);
  await client.query('COMMIT');
  return {status:inserted?'REGISTERED':'ALREADY_REGISTERED',productId,
    recommendationEligible:false,taxClass:'UNVERIFIED'};
 }catch(error){
  await client.query('ROLLBACK');
  throw error;
 }finally{client.release();}
}
