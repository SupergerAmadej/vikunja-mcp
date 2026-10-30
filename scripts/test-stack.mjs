// Build and exercise the actual production Compose services using only fresh,
// disposable data. Never starts the default Compose project or reads .env.
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFile,writeFile,mkdir,mkdtemp,chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const cache=join(root,'.tmp/stack-proof');await mkdir(cache,{recursive:true});
const directory=await mkdtemp(join(cache,'run-'));
const project=`vikunja-proof-${randomUUID().slice(0,8)}`;
const key=`test-${randomUUID()}`;
const env={...Object.fromEntries(Object.entries(process.env).filter(([name])=>!name.startsWith('VIKUNJA_') && !name.startsWith('COMPOSE_'))),
  VIKUNJA_TOKEN:'disposable-bootstrap-placeholder',VIKUNJA_MCP_API_KEY:key,VIKUNJA_JWT_SECRET:`disposable-${randomUUID()}`};
const envFile=join(directory,'empty.env');await writeFile(envFile,'');
function docker(args,options={}) {
  return (execFileSync('docker',args,{cwd:root,env,encoding:'utf8',maxBuffer:16*1024*1024,windowsHide:true,...options})??'').trim();
}
const config=JSON.parse(docker(['compose','--project-name',project,'--env-file',envFile,'-f','docker-compose.example.yml','config','--format','json']));
assert.equal(config.services.vikunja.build.dockerfile,'upstream/vikunja.Dockerfile');
assert.equal(String(config.services['vikunja-mcp'].environment.VIKUNJA_REQUIRE_ATOMIC_UPDATES),'1');
const services=['vikunja','vikunja-mcp'];
for(const service of services) {
  config.services[service].image=`vikunja-mcp:${project}-${service}`;
  config.services[service].ports=[{target:service==='vikunja'?3456:9090,published:'0',host_ip:'127.0.0.1',protocol:'tcp'}];
}
for(const name of ['db','files']) {await mkdir(join(directory,name));await chmod(join(directory,name),0o777);}
config.services.vikunja.volumes=[
  {type:'bind',source:join(directory,'db'),target:'/db'},
  {type:'bind',source:join(directory,'files'),target:'/app/vikunja/files'},
];
const configFile=join(directory,'compose.json');
const save=()=>writeFile(configFile,`${JSON.stringify(config,null,2)}\n`);
await save();
const compose=(args,options={})=>docker(['compose','--project-name',project,'--env-file',envFile,'-f',configFile,...args],options);
const address=service=>`http://${compose(['port',service,service==='vikunja'?'3456':'9090']).split('\n')[0]}`;
// Native fetch normalizes Host to the random published port. Use http.request
// when testing the production allowlist with its real internal port instead.
function httpRequest(url,options={}) {
  return new Promise((resolve,reject)=>{
    const request=http.request(url,options,response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('error',reject);
      response.on('end',()=>resolve({status:response.statusCode,ok:response.statusCode>=200 && response.statusCode<300,text:async()=>Buffer.concat(chunks).toString()}));
    });
    request.setTimeout(5000,()=>request.destroy(new Error('Test HTTP request timed out')));
    request.once('error',reject);request.end(options.body);
  });
}
async function waitFor(url,headers={}) {
  const deadline=Date.now()+90_000;
  while(Date.now()<deadline) {
    try {const response=headers.Host?await httpRequest(url,{headers}):await fetch(url,{headers,signal:AbortSignal.timeout(2000)});if(response.ok) return response;} catch {}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw new Error(`Service did not become ready: ${new URL(url).pathname}`);
}
let backend,mcp,owner,scoped;
async function api(path,method='GET',body,token=owner) {
  const response=await fetch(`${backend}/api/v1${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`} :{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15_000)});
  const value=await response.json();assert.ok(response.ok,`${method} ${path}: HTTP ${response.status}`);return value;
}
let requestId=0;
async function rpc(method,params={}) {
  const response=await httpRequest(`${mcp}/mcp`,{method:'POST',headers:{Host:'127.0.0.1:9090','X-API-Key':key,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++requestId,method,params})});
  assert.equal(response.status,200);
  const value=await response.text(),event=value.split('\n').find(line=>line.startsWith('data:'));
  const data=JSON.parse(event?event.slice(5):value);assert.ok(data.result,JSON.stringify(data));return data.result;
}
async function call(name,args) {
  const result=await rpc('tools/call',{name,arguments:args});assert.notEqual(result.isError,true,JSON.stringify(result));return result.structuredContent;
}
try {
  compose(['build'],{stdio:'inherit'});
  compose(['up','-d','--no-build','vikunja']);backend=address('vikunja');
  const info=await (await waitFor(`${backend}/api/v1/info`)).json();
  assert.equal(info.atomic_field_updates,1);assert.match(info.version,/2\.7\.1\+atomic-fields\.1/);
  const html=await (await fetch(backend)).text();assert.match(html,/<div id="app"/);
  const assets=[...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(match=>match[1]);
  assert.ok(assets.some(asset=>asset.endsWith('.js')),'The production frontend must contain a built script');
  for(const asset of assets) {
    const response=await fetch(new URL(asset,`${backend}/`));assert.equal(response.status,200);
    assert.doesNotMatch(response.headers.get('content-type')??'',/text\/html/);
    assert.ok((await response.arrayBuffer()).byteLength>0);
  }
  const download=await fetch(`${backend}/source/vikunja-2.7.1-atomic-fields.1.tar.gz`);assert.equal(download.status,200);
  const source=Buffer.from(await download.arrayBuffer());assert.equal(source.readUInt16BE(0),0x1f8b);
  const archive=join(directory,'corresponding-source.tar.gz');await writeFile(archive,source);
  const manifest=JSON.parse(await readFile(join(root,'upstream/vikunja-2.7.1-atomic-fields.json'),'utf8'));
  const model=execFileSync('tar',['-xzOf',archive,'./pkg/models/field_updates.go'],{windowsHide:true});
  assert.equal(createHash('sha256').update(model).digest('hex'),manifest.files.find(file=>file.path==='pkg/models/field_updates.go').afterSha256);
  const wrapper=execFileSync('tar',['-xzOf',archive,'./upstream/vikunja.Dockerfile'],{windowsHide:true});
  assert.deepEqual(wrapper,await readFile(join(root,'upstream/vikunja.Dockerfile')));
  await api('/register','POST',{username:'stack-proof',password:'disposable-stack-proof-123!',email:'stack@example.test'});
  owner=(await api('/login','POST',{username:'stack-proof',password:'disposable-stack-proof-123!'})).token;
  scoped=(await api('/tokens','PUT',{title:'Disposable field-write scope',expires_at:new Date(Date.now()+86_400_000).toISOString(),permissions:{projects:['read_all','read_one','create','fields'],tasks:['read_one','create','fields'],labels:['read_all','read_one','create','fields'],tasks_attachments:['read_all','create']}})).token;
  assert.match(scoped,/^tk_/);
  config.services['vikunja-mcp'].environment.VIKUNJA_TOKEN=scoped;await save();
  compose(['up','-d','--no-build']);mcp=address('vikunja-mcp');
  await waitFor(`${mcp}/readyz`,{Host:'127.0.0.1:9090','X-API-Key':key});
  assert.equal((await rpc('tools/list')).tools.length,42);
  const projectData=await call('create_project',{title:'Production stack proof',description:'Clear this description'});
  const task=await call('create_task',{projectId:projectData.id,title:'Persisted task',description:'Keep task description'});
  const label=await call('create_label',{title:'Production label',description:'Keep label description'});
  const attachment=(await call('upload_task_attachment',{taskId:task.id,filename:'persistence.txt',contentBase64:Buffer.from('Persisted attachment proof').toString('base64')})).attachments[0];
  assert.ok(attachment.id>0,'The restricted backend must still save attachment files');
  await call('update_task',{taskId:task.id,title:'Atomic task title'});
  await call('update_project',{projectId:projectData.id,description:''});
  await call('update_label',{labelId:label.id,title:'Atomic label title'});
  assert.equal((await api(`/tasks/${task.id}`)).description,'Keep task description');
  assert.equal((await api(`/projects/${projectData.id}`)).description,'');
  assert.equal((await api(`/labels/${label.id}`)).description,'Keep label description');
  const stale=await api(`/tasks/${task.id}`);
  await api(`/tasks/${task.id}`,'POST',{...stale,description:'External committed description'});
  const masked=await fetch(`${backend}/api/v2/tasks/${task.id}/fields?format=html`,{method:'POST',headers:{Authorization:`Bearer ${scoped}`,'Content-Type':'application/json'},body:JSON.stringify({...stale,title:'Masked stale snapshot',update_fields:['title']})});
  assert.equal(masked.status,200);assert.equal((await masked.json()).description,'External committed description');
  const reader=(await api('/tokens','PUT',{title:'Disposable read scope',expires_at:new Date(Date.now()+86_400_000).toISOString(),permissions:{tasks:['read_one']}})).token;
  const denied=await fetch(`${backend}/api/v2/tasks/${task.id}/fields`,{method:'POST',headers:{Authorization:`Bearer ${reader}`,'Content-Type':'application/json'},body:JSON.stringify({title:'Denied edit',update_fields:['title']})});
  assert.ok([401,403].includes(denied.status),'Read-only token must not authorize the new write route');
  for(const service of services) {
    const inspect=JSON.parse(docker(['inspect',compose(['ps','--quiet',service])]))[0];
    assert.equal(inspect.Config.User,service==='vikunja'?'1000:1000':'node');
    assert.equal(inspect.HostConfig.ReadonlyRootfs,true);assert.deepEqual(inspect.HostConfig.CapDrop,['ALL']);
  }
  compose(['up','-d','--force-recreate','--no-build']);backend=address('vikunja');mcp=address('vikunja-mcp');
  await waitFor(`${mcp}/readyz`,{Host:'127.0.0.1:9090','X-API-Key':key});
  const persisted=await call('get_task',{taskId:task.id});
  assert.equal(persisted.title,'Masked stale snapshot');assert.equal(persisted.description,'External committed description');
  assert.equal((await call('get_project',{projectId:projectData.id})).description,'');
  const persistedFile=await fetch(`${backend}/api/v1/tasks/${task.id}/attachments/${attachment.id}`,{headers:{Authorization:`Bearer ${owner}`}});
  assert.equal(persistedFile.status,200);assert.equal(await persistedFile.text(),'Persisted attachment proof');
  const evidence={checkedAt:new Date().toISOString(),backendVersion:info.version,atomicProtocol:info.atomic_field_updates,frontendAssets:assets.length,correspondingSource:true,scopedTokenWrites:true,readOnlyTokenDenied:true,staleSnapshotPreserved:true,persistenceAfterRecreation:true,attachmentPersistence:true,nonRoot:true,readOnlyRoot:true,tools:42,liveDeploymentChanged:false};
  await writeFile(join(directory,'verification.json'),`${JSON.stringify(evidence,null,2)}\n`);
  console.log(`Production Compose proof passed. Evidence: ${join(directory,'verification.json')}`);
} finally {
  try {await writeFile(join(directory,'containers.log'),compose(['logs','--no-color']));} catch {}
  compose(['down','--remove-orphans']);
  // Keep fresh test data/logs for diagnosis; only remove these test image tags.
  for(const service of services) {try {docker(['image','rm',config.services[service].image]);} catch {}}
}
