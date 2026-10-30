import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp,writeFile,mkdir,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { startMcp,listen,cleanEnv } from '../helpers/harness.mjs';

test('atomic field updates preserve independent client edits', {skip:!process.env.TEST_VIKUNJA_BINARY,timeout:90_000},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'vikunja-atomic-integration-'));
  await mkdir(join(directory,'files'));
  const reservation=await listen((_req,res)=>res.end());const url=reservation.url;await reservation.close();
  const config=join(directory,'config.yml');await writeFile(config,'{}\n');
  const env={...cleanEnv(),VIKUNJA_SERVICE_INTERFACE:new URL(url).host,VIKUNJA_SERVICE_ROOTPATH:directory,VIKUNJA_SERVICE_PUBLICURL:`${url}/`,VIKUNJA_SERVICE_JWTSECRET:'disposable-atomic-integration-secret-1234567890',VIKUNJA_SERVICE_ENABLEREGISTRATION:'true',VIKUNJA_DATABASE_TYPE:'sqlite',VIKUNJA_DATABASE_PATH:join(directory,'vikunja.db'),VIKUNJA_FILES_BASEPATH:join(directory,'files'),VIKUNJA_LOG_PATH:join(directory,'logs'),VIKUNJA_LOG_LEVEL:'WARNING',VIKUNJA_MAILER_ENABLED:'false'};
  let logs='',token,proxy,mcp,other,inject,barrier;
  const upstream=spawn(resolve(process.env.TEST_VIKUNJA_BINARY),['--config',config,'web'],{cwd:directory,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  upstream.stdout.on('data',b=>logs+=b);upstream.stderr.on('data',b=>logs+=b);
  async function api(path,method='GET',body,raw=false) {
    const response=await fetch(`${url}${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    if(raw) return response;
    const data=await response.json();assert.ok(response.ok,`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);return data;
  }
  async function call(name,args={},server=mcp) {
    const response=await server.rpc('tools/call',{name,arguments:args});
    assert.equal(response.status,200);assert.notEqual(response.data.result?.isError,true,JSON.stringify(response.data));return response.data.result.structuredContent;
  }
  try {
    const deadline=Date.now()+20_000;let ready=false;
    while(Date.now()<deadline) {
      if(upstream.exitCode!==null) throw new Error(logs);
      try {if((await fetch(`${url}/api/v1/info`)).ok) {ready=true;break;}} catch {}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.ok(ready,'Disposable backend did not start');
    await api('/api/v1/register','POST',{username:'atomic-test',password:'atomic-integration-test-123!',email:'atomic@example.test'});
    token=(await api('/api/v1/login','POST',{username:'atomic-test',password:'atomic-integration-test-123!'})).token;
    const owner=await api('/api/v1/user');
    const info=await api('/api/v1/info');
    t.diagnostic(`Advertised field-update protocol: ${info.atomic_field_updates??'absent'}`);
    // Deliberately retain a pre-write snapshot while another client commits a
    // change. The same assertions fail against stock 2.7.1, providing a negative
    // control instead of assuming a mock implements the fix correctly.
    proxy=await listen(async(req,res)=>{
      const chunks=[];for await(const chunk of req) chunks.push(chunk);
      const bytes=Buffer.concat(chunks);
      const response=await fetch(`${url}${req.url}`,{method:req.method,headers:{Authorization:req.headers.authorization??'',Accept:'application/json',...(bytes.length?{'Content-Type':'application/json'}:{})},body:bytes.length?bytes:undefined});
      const body=Buffer.from(await response.arrayBuffer());
      if(req.method==='GET' && inject?.path===req.url) {const pending=inject;inject=undefined;await pending.action();}
      if(req.method==='GET' && barrier?.path===req.url) {
        const pending=barrier,number=++pending.arrived;
        if(number===2) pending.releaseBoth();
        await pending.bothReady;
        if(number===2) await pending.firstCommitted;
      }
      if(req.method==='POST' && req.url.includes('/tasks/') && barrier?.arrived===2) barrier.releaseSecond();
      res.statusCode=response.status;
      for(const name of ['content-type','x-pagination-total-pages','x-pagination-result-count']) {
        const value=response.headers.get(name);if(value!==null) res.setHeader(name,value);
      }
      res.end(body);
    });
    const mcpEnv={VIKUNJA_TOKEN:token,VIKUNJA_REQUIRE_ATOMIC_UPDATES:process.env.TEST_REQUIRE_ATOMIC==='1'?'1':'0'};
    mcp=await startMcp(proxy.url,mcpEnv);
    if(process.env.TEST_REQUIRE_ATOMIC==='1') {
      assert.equal((await fetch(`${mcp.url}/readyz`,{headers:{'X-API-Key':'test-mcp-key'}})).status,200);
    }
    const project=await call('create_project',{title:'Atomic integration'});

    await t.test('a scalar task edit preserves an external reminder, assignee and favorite',async()=>{
      const task=await call('create_task',{projectId:project.id,title:'Original task',description:'Original description'});
      inject={path:`/api/v1/tasks/${task.id}`,action:async()=>{
        await api(`/api/v1/tasks/${task.id}`,'POST',{...await api(`/api/v1/tasks/${task.id}`),description:'External description',assignees:[{id:owner.id}],reminders:[{reminder:'2027-01-01T00:00:00Z'}],is_favorite:true});
      }};
      await call('update_task',{taskId:task.id,title:'MCP title'});
      const stored=await api(`/api/v1/tasks/${task.id}`);
      assert.equal(stored.title,'MCP title');assert.equal(stored.description,'External description');
      assert.deepEqual(stored.assignees.map(u=>u.id),[owner.id]);assert.equal(stored.reminders.length,1);assert.equal(stored.is_favorite,true);
    });
    await t.test('reminder replacement preserves an external scalar task edit',async()=>{
      const task=await call('create_task',{projectId:project.id,title:'Reminder task',description:'Original description'});
      inject={path:`/api/v1/tasks/${task.id}`,action:async()=>{
        await api(`/api/v1/tasks/${task.id}`,'POST',{...await api(`/api/v1/tasks/${task.id}`),description:'External scalar description',priority:5});
      }};
      await call('set_task_reminders',{taskId:task.id,reminders:[{reminder:'2027-01-01T00:00:00Z'}]});
      const stored=await api(`/api/v1/tasks/${task.id}`);
      assert.equal(stored.description,'External scalar description');assert.equal(stored.priority,5);assert.equal(stored.reminders.length,1);
    });
    await t.test('explicitly requested unchanged fields remain in the write intent',async()=>{
      const task=await call('create_task',{projectId:project.id,title:'Intent task',priority:1});
      inject={path:`/api/v1/tasks/${task.id}`,action:async()=>{
        await api(`/api/v1/tasks/${task.id}`,'POST',{...await api(`/api/v1/tasks/${task.id}`),priority:5});
      }};
      await call('update_task',{taskId:task.id,title:'Requested title',priority:1});
      const stored=await api(`/api/v1/tasks/${task.id}`);assert.equal(stored.title,'Requested title');assert.equal(stored.priority,1);
    });
    await t.test('project title edits preserve an external description, identifier and color',async()=>{
      const item=await call('create_project',{title:'Original project',description:'Original project description',identifier:'OLD',hexColor:'112233'});
      inject={path:`/api/v1/projects/${item.id}`,action:async()=>{
        await api(`/api/v1/projects/${item.id}`,'POST',{...await api(`/api/v1/projects/${item.id}`),description:'External project description',identifier:'EXT',hex_color:'abcdef',is_favorite:true});
      }};
      await call('update_project',{projectId:item.id,title:'MCP project'});
      const stored=await api(`/api/v1/projects/${item.id}`);
      assert.equal(stored.title,'MCP project');assert.equal(stored.description,'External project description');assert.equal(stored.identifier,'EXT');assert.equal(stored.hex_color,'abcdef');assert.equal(stored.is_favorite,true);
    });
    await t.test('label title edits preserve an external description and color',async()=>{
      const item=await call('create_label',{title:'Original label',description:'Original label description',hexColor:'112233'});
      inject={path:`/api/v1/labels/${item.id}`,action:async()=>{
        await api(`/api/v1/labels/${item.id}`,'POST',{...await api(`/api/v1/labels/${item.id}`),description:'External label description',hex_color:'abcdef'});
      }};
      await call('update_label',{labelId:item.id,title:'MCP label'});
      const stored=await api(`/api/v1/labels/${item.id}`);
      assert.equal(stored.title,'MCP label');assert.equal(stored.description,'External label description');assert.equal(stored.hex_color,'abcdef');
    });
    await t.test('two MCP processes retain disjoint edits made from the same snapshot',async()=>{
      other=await startMcp(proxy.url,mcpEnv);
      const task=await call('create_task',{projectId:project.id,title:'Two writers',description:'Original description'});
      let releaseBoth,releaseSecond;
      const bothReady=new Promise(resolve=>{releaseBoth=resolve;});
      const firstCommitted=new Promise(resolve=>{releaseSecond=resolve;});
      // Both snapshots precede either write. Deliver the writes sequentially:
      // SQLite advertises that overlapping write transactions are unsupported.
      barrier={path:`/api/v1/tasks/${task.id}`,arrived:0,bothReady,firstCommitted,releaseBoth,releaseSecond};
      const both=await Promise.all([call('update_task',{taskId:task.id,title:'Writer one'}),call('update_task',{taskId:task.id,description:'Writer two'},other)]);
      assert.equal(both.length,2);assert.equal(barrier.arrived,2);barrier=undefined;
      const stored=await api(`/api/v1/tasks/${task.id}`);assert.equal(stored.title,'Writer one');assert.equal(stored.description,'Writer two');
      await other.close();other=undefined;
    });
    await t.test('a task moved externally returns its current project index and identifier',async()=>{
      const destination=await call('create_project',{title:'External destination',identifier:'NEXT'});
      await call('create_task',{projectId:destination.id,title:'Existing destination task'});
      await call('create_task',{projectId:destination.id,title:'Another destination task'});
      const task=await call('create_task',{projectId:project.id,title:'Moved task'});
      inject={path:`/api/v1/tasks/${task.id}`,action:async()=>{
        await api(`/api/v1/tasks/${task.id}`,'POST',{...await api(`/api/v1/tasks/${task.id}`),project_id:destination.id});
      }};
      const result=await call('update_task',{taskId:task.id,title:'Renamed after move'});
      const stored=await api(`/api/v1/tasks/${task.id}`);
      assert.equal(stored.project_id,destination.id);assert.equal(result.project_id,stored.project_id);
      assert.notEqual(stored.index,task.index);assert.equal(result.index,stored.index);assert.equal(result.identifier,stored.identifier);
    });
    await t.test('the extension clears project descriptions without dropping unrelated fields',async()=>{
      const item=await call('create_project',{title:'Clear description',description:'Clear me',hexColor:'abcdef'});
      await call('update_project',{projectId:item.id,description:''});
      const stored=await api(`/api/v1/projects/${item.id}`);assert.equal(stored.description,'');assert.equal(stored.title,'Clear description');assert.equal(stored.hex_color,'abcdef');
    });
    await t.test('relative reminders are revalidated when another client clears their base date',async()=>{
      const task=await call('create_task',{projectId:project.id,title:'Date race',dueDate:'2027-01-01T00:00:00Z'});
      inject={path:`/api/v1/tasks/${task.id}`,action:async()=>{
        await api(`/api/v1/tasks/${task.id}`,'POST',{...await api(`/api/v1/tasks/${task.id}`),due_date:null});
      }};
      const result=(await mcp.rpc('tools/call',{name:'set_task_reminders',arguments:{taskId:task.id,reminders:[{relativeTo:'due_date',relativePeriodSeconds:-60}]}})).data.result;
      assert.equal(result.isError,true);assert.match(result.content[0].text,/due_date is not set/);
      const stored=await api(`/api/v1/tasks/${task.id}`);assert.match(stored.due_date,/0001-01-01/);assert.equal((stored.reminders??[]).length,0);
    });
    assert.equal(info.atomic_field_updates,1,'The passing suite must use an explicitly advertised protocol, not a legacy fallback');
  } finally {
    barrier?.releaseBoth();barrier?.releaseSecond();
    await other?.close();await mcp?.close();await proxy?.close();
    if(upstream.exitCode===null) {const exited=once(upstream,'exit');upstream.kill();await exited;}
    await rm(directory,{recursive:true,force:true});
  }
});
