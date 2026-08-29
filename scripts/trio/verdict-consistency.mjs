/**
 * Publication consistency for verifier outcomes.
 *
 * An evidence bundle is only worth its digest if the outcome inside it hangs together. The
 * previous writer decided success by comparing the verdict to a hardcoded expectation --
 * `VERIFIER_OK_DIVERGENCE` -- which meant it reported failure the moment the trio actually
 * reached parity, and would have reported success for a divergence bundle whose counts
 * contradicted its own verdict.
 *
 * Replacing one hardcoded expectation with the opposite one would repeat the mistake in the
 * other direction. So nothing here asserts *which* outcome is correct. It asserts that the
 * outcome is internally consistent: that the status, the verdict, the counters and the
 * failure list all describe the same run, and that the verifier which produced them was
 * certified for the bytes it was running. Anything unrecognised, absent, or malformed fails
 * closed -- a bundle that cannot be shown to be coherent is not publishable.
 */

export const PUBLICATION_CONTRACT=Object.freeze({
  version:'1.0.0',
  publishableStatuses:Object.freeze(['VERIFIER_OK_PARITY','VERIFIER_OK_DIVERGENCE']),
  /**
   * Counters that can independently justify a blocking outcome.
   *
   * `blockingCount` is the ordinary one. The rest are named explicitly so that a divergence
   * carrying, say, quarantined content is still publishable rather than being rejected for
   * failing to match a single hardcoded shape.
   */
  blockingConditions:Object.freeze(['blockingCount','missingBehaviorFiles','quarantined','unclassifiedFiles','contentValidationFailures'])
});

const isCount=(value)=>Number.isInteger(value)&&value>=0;

/** A security-blocked run may emit this refusal record, but never an evidence bundle. */
export function securityEvidenceRefusal(result){
  if(result?.status!=='VERIFIER_SECURITY_BLOCKED')return null;
  const first=result.failures?.[0];
  return {status:'EVIDENCE_REFUSED',verifierStatus:result.status,errorCode:first?.failureClass??'VERIFIER_SECURITY_BLOCKED',relativePath:first?.affectedPath??null,category:first?.details?.category??'security-boundary',contentsRead:false};
}

/**
 * Assess whether a verifier result may be published.
 *
 * @param result        the verifier result object
 * @param certification the outcome of validateCertification() for the running verifier
 * @param suites        optional suite runs: [{file, exitCode, failed}]
 * @returns {{ok:boolean, status:string|null, verdict:string|null, problems:Array<object>}}
 */
export function assessPublication(result,certification,suites=[]){
  const problems=[];
  const fail=(message,details={})=>problems.push({message,...details});

  if(!result||typeof result!=='object'||Array.isArray(result)){
    return {ok:false,status:null,verdict:null,problems:[{message:'verifier result is missing or is not an object'}]};
  }
  const status=typeof result.status==='string'?result.status:null;
  const summary=result.summary&&typeof result.summary==='object'&&!Array.isArray(result.summary)?result.summary:null;
  const verdict=summary&&typeof summary.verdict==='string'?summary.verdict:null;

  if(status===null)fail('verifier result has no status');
  if(summary===null)fail('verifier result has no summary object');
  if(summary!==null&&verdict===null)fail('verifier summary has no verdict');
  if(!Array.isArray(result.failures))fail('verifier result has no failures array');

  // Counters must be counts before they can be compared to anything.
  if(summary!==null){
    if(!isCount(summary.blockingCount))fail('summary.blockingCount is not a non-negative integer',{blockingCount:summary.blockingCount??null});
    if(summary.unclassifiedFiles!==undefined&&!isCount(summary.unclassifiedFiles))fail('summary.unclassifiedFiles is not a non-negative integer',{unclassifiedFiles:summary.unclassifiedFiles});
    for(const key of PUBLICATION_CONTRACT.blockingConditions)
      if(summary[key]!==undefined&&!isCount(summary[key]))fail(`summary.${key} is not a non-negative integer`,{[key]:summary[key]});
  }
  if(problems.length)return {ok:false,status,verdict,problems};

  // The failure list and the count of failures are two statements about the same run.
  if(summary.blockingCount!==result.failures.length)
    fail('summary.blockingCount does not match the number of reported failures',{blockingCount:summary.blockingCount,failures:result.failures.length});
  if(summary.blockingByClass&&typeof summary.blockingByClass==='object'){
    const total=Object.values(summary.blockingByClass).reduce((n,x)=>n+(Number.isInteger(x)?x:Number.NaN),0);
    if(!Number.isInteger(total)||total!==summary.blockingCount)
      fail('summary.blockingByClass does not sum to summary.blockingCount',{sum:Number.isInteger(total)?total:null,blockingCount:summary.blockingCount});
  }

  if(!PUBLICATION_CONTRACT.publishableStatuses.includes(status)){
    fail('verifier status is not a publishable outcome',{status});
  }else if(status==='VERIFIER_OK_PARITY'){
    if(verdict!=='PARITY')fail('parity status is paired with a non-parity verdict',{status,verdict});
    if(summary.blockingCount!==0)fail('parity is claimed with blocking findings',{blockingCount:summary.blockingCount});
    if(summary.unclassifiedFiles!==0)fail('parity is claimed with unclassified files',{unclassifiedFiles:summary.unclassifiedFiles});
    if(result.failures.length!==0)fail('parity is claimed with a non-empty failure list',{failures:result.failures.length});
  }else{
    if(verdict!=='BLOCKING_DIVERGENCE')fail('divergence status is paired with a non-divergence verdict',{status,verdict});
    const justified=PUBLICATION_CONTRACT.blockingConditions.filter((key)=>isCount(summary[key])&&summary[key]>0);
    if(!justified.length)fail('divergence is claimed without any blocking condition',{checked:PUBLICATION_CONTRACT.blockingConditions});
  }

  // The verifier that produced this outcome must have been certified for the bytes it ran.
  if(!certification||certification.ok!==true){
    fail('the verifier that produced this result is not certified',{problems:certification?.problems??null});
  }
  const embedded=result.verifierCertification;
  if(!embedded||typeof embedded!=='object')fail('verifier result carries no certification record');
  else if(embedded.certified===false)fail('verifier result carries an explicitly uncertified record',{problems:embedded.problems??null});
  else if(certification?.ok===true&&embedded.certificationDigest!==certification.certification.certificationDigest)
    fail('the embedded certification digest is not the digest of the running verifier',{embedded:embedded.certificationDigest??null,running:certification.certification.certificationDigest});

  for(const suite of suites??[]){
    if(suite?.exitCode!==0)fail('a supporting suite did not pass',{file:suite?.file??null,exitCode:suite?.exitCode??null});
    else if(Number.isInteger(suite.failed)&&suite.failed>0)fail('a supporting suite reported failures',{file:suite.file,failed:suite.failed});
  }

  return {ok:problems.length===0,status,verdict,problems};
}
