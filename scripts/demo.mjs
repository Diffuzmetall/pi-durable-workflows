import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {readFile,writeFile,lstat,realpath,readdir,mkdir,mkdtemp} from 'node:fs/promises';
import {finished} from 'node:stream/promises';
import {fileURLToPath} from 'node:url';
import {dirname,join,resolve} from 'node:path';
process.umask(0o077);
const product=await realpath(dirname(dirname(fileURLToPath(import.meta.url))));
const candidate=product;
const node=process.execPath;
const dataParent=resolve(process.env.DURABLE_JOBS_DEMO_ROOT ?? join(product,'.data'));
await mkdir(dataParent,{recursive:true,mode:0o700});
assert.equal(await realpath(dataParent),dataParent,'demo parent must be a physical path');
const parentStat=await lstat(dataParent);
assert(parentStat.isDirectory()&&!parentStat.isSymbolicLink());
assert.equal(parentStat.uid,process.geteuid());
assert.equal(parentStat.mode&0o777,0o700,'demo parent must be private (0700)');
const root=await mkdtemp(join(dataParent,'demo-'));
const store=join(root,'jobs.sqlite');
const secret=randomBytes(32).toString('hex'); // private in memory; never persisted or printed
const env={HOME:root,LANG:'C',TZ:'UTC',DURABLE_JOBS_STORE:store,DURABLE_JOBS_SECRET:secret,DURABLE_JOBS_LOGICAL_BACKUP_DIR:root};
const active=new Set(); const actors=[]; let serial=0; let current;
const hash=b=>createHash('sha256').update(b).digest('hex');
const save=(name,v)=>writeFile(join(root,name),JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function bounded(p,ms,label){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]);}finally{clearTimeout(timer);}}
async function identity(path){const s=await lstat(path,{bigint:true});assert(!s.isSymbolicLink());assert.equal(await realpath(path),path);return Object.fromEntries(['dev','ino','uid','mode','nlink'].map(k=>[k,String(s[k])]));}
async function inventory(){const result={};for(const name of (await readdir(root)).sort()){const p=join(root,name);const s=await lstat(p);assert(s.isFile()&&!s.isSymbolicLink(),name);assert.equal(s.uid,process.geteuid());assert.equal(s.nlink,1);const b=await readFile(p);result[name]={identity:await identity(p),bytes:b.length,sha256:hash(b)};}return result;}
function launch(label,args,overrides={}){
 const stem=`${String(++serial).padStart(3,'0')}-${label}`;
 const child=spawn(node,args,{cwd:candidate,env:{...env,...overrides},stdio:['ignore','pipe','pipe']});
 const item={label,pid:child.pid,args,stdout:'',stderr:'',ready:false,exited:false};actors.push(item);active.add(child);
 const out=createWriteStream(join(root,stem+'.stdout.log'),{flags:'wx',mode:0o600});
 const err=createWriteStream(join(root,stem+'.stderr.log'),{flags:'wx',mode:0o600});
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
 child.stdout.on('data',s=>{item.stdout+=s;});child.stderr.on('data',s=>{item.stderr+=s;});
 child.stdout.pipe(out);child.stderr.pipe(err);
 const streams=Promise.all([finished(child.stdout),finished(child.stderr),finished(out),finished(err)]);void streams.catch(()=>{});
 const exit=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{item.exited=true;item.exit={code,signal};active.delete(child);resolve(item.exit);});});void exit.catch(()=>{});
 const joined=exit.then(async value=>{await streams;return value;});void joined.catch(()=>{});
 return {child,item,joined};
}
function jsonLines(text){return text.split('\n').filter(Boolean).map(line=>JSON.parse(line));}
async function cli(label,args){const p=launch(label,[product+'/bin/jobs.mjs',...args]);const exit=await bounded(p.joined,15000,'CLI observation timeout; no retry/automatic termination');assert.deepEqual(exit,{code:0,signal:null},p.item.stderr);const lines=jsonLines(p.item.stdout);assert.equal(lines.length,1);return lines[0];}
async function openOwner(label){
 await verifyPhysical();
 const p=launch(label,[product+'/bin/owner.mjs',product+'/examples/OFFLINE-DEMO.host.json']);current=p;
 const until=Date.now()+30000;
 while(Date.now()<until){
  const lines=p.item.stdout.split('\n').filter(Boolean);
  for(const line of lines){let v;try{v=JSON.parse(line);}catch{continue;}if(v.startup){assert.equal(v.startup.status,'ready',line);assert.equal(v.foreground,true);p.item.ready=true;p.mainIdentity=await identity(store);return p;}}
  if(p.item.exited){await p.joined;throw new Error('Owner exited before ready: '+p.item.stderr);}
  await pause(50);
 }
 throw new Error('Owner startup observation timeout; unknown native ownership retained');
}
async function verifyPhysical(){assert.equal(await realpath(root),root);const d=await lstat(root);assert(d.isDirectory());assert.equal(d.uid,process.geteuid());assert.equal(d.mode&0o777,0o700);for(const name of ['jobs.sqlite','jobs.sqlite-wal','jobs.sqlite-shm','jobs.sqlite-journal']){try{const s=await lstat(join(root,name));assert(s.isFile()&&!s.isSymbolicLink());assert.equal(s.uid,process.geteuid());assert.equal(s.nlink,1);assert.equal(await realpath(join(root,name)),join(root,name));}catch(e){if(e.code!=='ENOENT')throw e;}}}
function decode(c){switch(c[0]){case'null':return null;case'text':return c[1];case'number-f64be':return Buffer.from(c[1],'hex').readDoubleBE();case'bigint':return BigInt(c[1]);case'blob-base64':return Buffer.from(c[1],'base64');default:throw new Error('Unknown captured cell');}}
const records=rows=>rows.map(row=>Object.fromEntries(row.map(([k,v])=>[k,decode(v)])));
async function closeOwner(p,label){
 assert(p.item.ready&&!p.item.exited,'only verified fresh ready owner is signalled');
 assert(!p.closeRequested,'no native shutdown retry');p.closeRequested=true;
 assert(p.child.kill('SIGTERM'),'owned graceful shutdown request');
 const exit=await bounded(p.joined,30000,'Native close unverified; NEVER force terminate');
 assert.deepEqual(exit,{code:0,signal:null},p.item.stderr);assert(!p.item.stderr.includes('host_runtime_failed'));
 const receipts=jsonLines(p.item.stdout).filter(x=>x.logicalBackup).map(x=>x.logicalBackup);assert.equal(receipts.length,1);
 const r=receipts[0];assert.equal(dirname(r.path),root);assert.match(r.path,/logical-backup-[\w-]+\.json$/);
 const bytes=await readFile(r.path);assert.equal(hash(bytes),r.sha256);assert.equal(bytes.length,r.bytes);
 const snap=JSON.parse(bytes);assert.equal(snap.format,'durable-jobs-logical-backup-v1');assert.equal(snap.authoritative,false);
 assert.equal(hash(JSON.stringify(snap.committed)),r.committedSha256);assert.equal(snap.committedSha256,r.committedSha256);
 assert.deepEqual(snap.physical.main,p.mainIdentity);assert.deepEqual(await identity(store),p.mainIdentity);
 assert.deepEqual(snap.physical.root,await identity(root));
 assert.deepEqual(Object.keys(snap.committed.rows).sort(),['durable_schema','durable_metadata','record_ids','conversations','entries','tasks','submissions','documents','document_revisions'].sort());
 await verifyPhysical();await save(label+'-closed.json',{exit,receipt:r,physicalMain:await identity(store),inventory:await inventory(),note:'Stock capture gate reviewed; backup produced before stock close. Exit and both streams joined.'});
 current=undefined;return {receipt:r,snapshot:snap};
}
async function inspectNative(snap,runId,status){
 const tables=Object.fromEntries(Object.entries(snap.committed.rows).map(([k,v])=>[k,records(v)]));
 const nativeTasks=tables.tasks.map(x=>JSON.parse(x.record));const byId=new Map(nativeTasks.map(x=>[x.id,x]));
 assert.equal(nativeTasks.filter(x=>x.kind==='jobs.run').length,1,'negative CLI calls did not create additional runs');assert.equal(nativeTasks.length,7);
 const run=byId.get(runId);assert(run);assert.equal(run.kind,'jobs.run');assert.equal(run.state.status,'terminal');assert.equal(run.state.outcome.status,'completed');
 const stages=nativeTasks.filter(x=>x.kind==='jobs.stage');const generations=nativeTasks.filter(x=>x.kind==='pi.generation');assert.equal(stages.length,3);assert.equal(generations.length,3);
 const {agentCompletion}=await import(product+'/src/agent-result.ts');
 const {offlineDemoAgents,offlineDemoValue}=await import(product+'/src/host.ts');
 const agents=offlineDemoAgents();const conversations=new Map(tables.conversations.map(x=>{const r=JSON.parse(x.record);return[r.id,r];}));
 const entries=new Map(tables.entries.map(x=>{const r=JSON.parse(x.record);return[r.id,r];}));
 const submissions=new Map(tables.submissions.map(x=>{const r=JSON.parse(x.record);return[r.id,r];}));
 let input={topic:'OFFLINE DEMO'};
 for(const [i,accepted] of status.accepted.entries()){
  const stage=byId.get(accepted.stageTaskId);assert.equal(stage.owner,run.id);assert.equal(stage.conversationId,run.conversationId);assert.equal(stage.state.outcome.status,'completed');assert.deepEqual(stage.input.input,input);
  const receipt=stage.state.outcome.result;const expected=offlineDemoValue(input);assert.deepEqual(receipt.value,expected);assert.deepEqual(accepted.value,expected);
  const proof=agentCompletion({conversationId:receipt.conversationId,ownerConversationId:run.conversationId,ownerTaskId:stage.id,submissionId:receipt.submissionId,requestId:`jobs-stage:${stage.id}`},{conversation:conversations.get(receipt.conversationId),submission:submissions.get(receipt.submissionId),entry:entries.get(receipt.answerEntryId),generation:byId.get(receipt.generationTaskId)},agents[i].output);
  assert.equal(proof.ok,true);assert.deepEqual(proof.value,expected);input=expected;
 }
 // Native SQL indexes use encodeIndexedString; actual DocumentRecord carries the plain kind.
 const budgetDoc=tables.documents.find(x=>JSON.parse(x.record).kind==='jobs.budget');assert(budgetDoc);assert.equal(budgetDoc.kind,JSON.stringify('jobs.budget'));
 const revisions=tables.document_revisions.filter(x=>x.document_id===budgetDoc.id).sort((a,b)=>a.seq-b.seq);const last=revisions.at(-1);assert(last);assert.equal(last.kind,'base');
 const ledger=JSON.parse(last.content);const budget=ledger.runs[String(runId)];assert(budget);assert.equal(budget.requests,3);assert.equal(budget.reservations.length,3);assert(budget.reservations.every(x=>x.status==='settled'));
 assert.equal(budget.snapshot,JSON.stringify(run.input));assert.deepEqual(budget.limits,run.input.budget);assert(budget.outputTokens<=budget.limits.maxOutputTokens);
 await save('native-proof.json',{runId,stages:stages.map(x=>x.id),generations:generations.map(x=>x.id),requests:budget.requests,outputTokens:budget.outputTokens,allReservationsSettled:true,validatedNativeAnswers:3,completeTables:9});
}
async function main(){
 const [major,minor]=process.versions.node.split('.').map(Number);assert(major>24||major===24&&minor>=19,'Node >=24.19 required');assert.equal(dirname(root),dataParent);await verifyPhysical();assert(!(await readdir(root)).includes('jobs.sqlite'));
 await save('admission.json',{controllerPid:process.pid,nonce:randomUUID(),root,rootIdentity:await identity(root),candidate,sdkVersion:'1.2.0',scope:'Two successful actual foreground native owner lifecycles, one explicit offline-demo run; nine negative literal CLI children and one refused duplicate foreground-owner attempt against ONLY the known fresh owned listener. Source-reviewed endpoint-before-native-open ordering, no extra connection. No forced native termination, live provider, external network or manual cleanup. Each close gated by full pre-close logical backup. Failure cleanup may retain unfinished records and is not success/interrupted-recovery proof.',sourceHashes:Object.fromEntries(await Promise.all(['src/host.ts','src/native-capture.ts','bin/owner.mjs','examples/OFFLINE-DEMO.host.json','examples/research-check-final.json','examples/OFFLINE-DEMO.input.json'].map(async f=>[f,hash(await readFile(product+'/'+f))])))});
 const negative=[];
 const malformed=join(root,'malformed.json');await writeFile(malformed,'{',{flag:'wx',mode:0o600});
 await save('unknown-agent.json',{version:1,steps:[{id:'one',agent:'unregistered-agent'}]});
 await save('duplicate-step.json',{version:1,steps:[{id:'same',agent:'researcher'},{id:'same',agent:'checker'}]});
 await save('injected-permission.json',{version:1,steps:[{id:'one',agent:'researcher',tools:['read']}]});
 const a=await openOwner('owner-a');
 async function denied(label,args,code,error,overrides={}){
  const p=launch(label,[product+'/bin/jobs.mjs',...args],overrides);
  const exit=await bounded(p.joined,15000,'negative CLI observation timeout; retain owner, no retry');
  assert.deepEqual(exit,{code,signal:null});assert.equal(p.item.stdout,'');assert.deepEqual(jsonLines(p.item.stderr),[{error:{code:error}}]);
  assert(!p.item.stderr.includes(root));assert(!p.item.stderr.includes(secret));
  negative.push({label,exit,error});
 }
 const definition=product+'/examples/research-check-final.json';
 const input=product+'/examples/OFFLINE-DEMO.input.json';
 await denied('malformed-definition',['start',malformed,'--input',input],2,'invalid_json');
 await denied('malformed-input',['start',definition,'--input',malformed],2,'invalid_json');
 await denied('unknown-agent',['start',join(root,'unknown-agent.json'),'--input',input],1,'jobs_failed');
 await denied('duplicate-step',['start',join(root,'duplicate-step.json'),'--input',input],1,'jobs_failed');
 await denied('injected-permission',['start',join(root,'injected-permission.json'),'--input',input],1,'jobs_failed');
 await denied('invalid-id',['status','0'],2,'invalid_arguments');
 await denied('unknown-status',['status','2147483647'],1,'jobs_failed');
 await denied('unknown-cancel',['cancel','2147483647'],1,'jobs_failed');
 await denied('wrong-auth',['status','2147483647'],1,'jobs_failed',{DURABLE_JOBS_SECRET:'x'.repeat(64)});
 // Only this fixture's verified fresh owned listener is targeted; no existing/unowned server or fallback port.
 const collision=launch('duplicate-owner',[product+'/bin/owner.mjs',product+'/examples/OFFLINE-DEMO.host.json']);
 const collisionExit=await bounded(collision.joined,15000,'duplicate owner unresolved; retain all ownership, no termination');
 assert.deepEqual(collisionExit,{code:1,signal:null});assert.equal(collision.item.stdout,'');
 assert.deepEqual(jsonLines(collision.item.stderr.split('\n').filter(x=>x.startsWith('{')).join('\n')),[{error:{code:'host_start_failed'}}]);
 assert(!collision.item.stderr.includes(secret));assert(!a.item.exited);assert.deepEqual(await identity(store),a.mainIdentity);
 negative.push({label:'duplicate-owner',exit:collisionExit,error:'host_start_failed',scope:'Observed endpoint refusal; source-reviewed bind-before-backend guard. Not a constructor counter.'});
 assert.equal(negative.length,10);await save('negative-cases.json',negative);
 const started=await cli('start',['start',definition,'--input',input]);assert(Number.isSafeInteger(started.runId)&&started.runId>0);
 let status;const polls=[];for(let i=0;i<40;i++){status=await cli('status',['status',String(started.runId)]);polls.push(status);if(status.settled)break;await pause(100);}
 await save('polls.json',polls);assert.equal(status.lifecycle,'succeeded');assert.equal(status.nativeOutcome,'completed');assert.equal(status.settled,true);assert.deepEqual(status.accepted.map(x=>x.stepId),['research','check','final']);
 const first=await closeOwner(a,'first');await inspectNative(first.snapshot,started.runId,status);
 const preserved=await inventory();const b=await openOwner('owner-b');assert.deepEqual(b.mainIdentity,a.mainIdentity);
 const reopened=await cli('status-reopen',['status',String(started.runId)]);assert.deepEqual(reopened,status);
 const second=await closeOwner(b,'second');assert.notEqual(first.receipt.path,second.receipt.path);assert.deepEqual(second.snapshot.committed,first.snapshot.committed);assert.equal(second.receipt.committedSha256,first.receipt.committedSha256);
 for(const [name,before] of Object.entries(preserved)){if(['jobs.sqlite-wal','jobs.sqlite-shm','jobs.sqlite-journal'].includes(name))continue;assert.deepEqual(await identity(join(root,name)),before.identity,name);if(name==='jobs.sqlite')continue;assert.equal(hash(await readFile(join(root,name))),before.sha256,name);}
 assert.equal(active.size,0);await save('actors.json',actors);await save('PASS.json',{runId:started.runId,actualCLI:true,actualNativeSqlite:true,negativeChecks:10,onlyOneRunAndSevenTasksPersisted:true,threeValidatedNativeHandoffs:true,completeNineTableReopenParity:true,noGenerationReplay:true,allChildExitsStreamsJoined:true,retainedBackups:[first.receipt,second.receipt],normalPackagedSDK:true,sourceHooks:false,notProved:['active cancellation','interrupted recovery','live provider','independent boundary audit']});
 await save('status.json',status);await save('result.json',status.accepted.at(-1).value);
 console.log('PASS OFFLINE DEMO: native CLI/SQLite healthy reopen');
 console.log(JSON.stringify({runId:started.runId,status:status.lifecycle,result:status.accepted.at(-1).value,saved:root}));
}
try{await main();}catch(error){
 await save('FAIL.json',{error:{name:error.name,message:error.message,stack:error.stack},actors,activePids:[...active].map(x=>x.pid),note:'No forced native termination or automatic retry. Retain all files/resources. Native success NOT claimed.'}).catch(()=>{});
 console.error(error);process.exitCode=1;
 // Native owner stays available for diagnosis. Never turn a failed assertion into an implicit process-group kill.
 if(current?.item.ready&&!current.item.exited&&!current.closeRequested){try{await closeOwner(current,'failure-cleanup');}catch(e){console.error('Native cleanup unresolved:',e.message);}}
 if(active.size){setInterval(()=>{},60000);}
}
