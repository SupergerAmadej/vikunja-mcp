import { test,before,after,beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { fixture,startMcp } from './helpers/harness.mjs';

let api,mcp,originalTask,originalProject;
before(async()=>{
  api=await fixture(); originalTask=structuredClone(api.state.task); originalProject=structuredClone(api.state.project);
  // Exercise the retained stock compatibility path explicitly.
  mcp=await startMcp(api.url,{VIKUNJA_REQUIRE_ATOMIC_UPDATES:'0'});
});
after(async()=>{await mcp?.close();await api?.close();});
beforeEach(()=>{
  api.state.task=structuredClone(originalTask);api.state.project=structuredClone(originalProject);
  api.state.calls=[];api.state.delay=0;api.state.failWrite=false;api.state.beforeWrite=undefined;api.state.pagination={};
  api.state.upload={success:[{id:77,task_id:1,file:{name:'fixture.txt',size:7}}],errors:null};
  api.state.atomicSupport=false;api.state.label={id:1,title:'Original label',description:'Keep label',hex_color:'112233'};
  api.state.taskLabels=[{id:7,title:'Label'}];api.state.repeatLabelPage=false;api.state.emptyLabelPage=undefined;
});
async function call(name,args={}) {
  const response=await mcp.rpc('tools/call',{name,arguments:args});
  assert.equal(response.status,200);assert.ok(response.data.result,JSON.stringify(response.data));return response.data.result;
}
function success(result) {assert.notEqual(result.isError,true,JSON.stringify(result));return result.structuredContent;}

test('protocol initializes and registers all tools with safe removal annotations',async()=>{
  const init=await mcp.rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'tests',version:'1'}});
  assert.equal(init.status,200);assert.equal(init.data.result.serverInfo.name,'vikunja-http');
  assert.equal(init.data.result.serverInfo.version,JSON.parse(await readFile(new URL('../package.json',import.meta.url))).version);
  const list=await mcp.rpc('tools/list');assert.equal(list.data.result.tools.length,42);
  for(const tool of list.data.result.tools) assert.equal(tool.inputSchema.additionalProperties,false,tool.name);
  for(const name of ['remove_task_relation','remove_subtask_relation','remove_task_label','replace_task_labels','set_task_assignees','set_task_reminders']) {
    assert.equal(list.data.result.tools.find(t=>t.name===name).annotations.destructiveHint,true,name);
  }
});

test('unknown arguments and empty patches fail before any upstream request',async()=>{
  for(const [name,args] of [
    ['update_task',{taskId:1}],['update_task',{taskId:1,startDate:'2027-01-01T00:00:00Z'}],
    ['update_task',{taskId:1,title:'Do not apply',startDate:'2027-01-01T00:00:00Z'}],
    ['update_project',{projectId:1}],['update_project',{projectId:1,title:'No',typo:true}],
    ['update_label',{labelId:1}],['update_label',{labelId:1,title:'No',typo:true}],
    ['vikunja_health',{typo:true}],['get_task',{taskId:1,expnad:['comments']}],
  ]) assert.equal((await call(name,args)).isError,true,`${name}: ${JSON.stringify(args)}`);
  assert.equal(api.state.calls.length,0);
  assert.equal(api.state.task.title,originalTask.title);assert.equal(api.state.project.title,originalProject.title);
});

test('a supported unchanged patch is a verified no-op rather than an empty-input error',async()=>{
  const result=success(await call('update_task',{taskId:1,title:originalTask.title}));
  assert.equal(result.title,originalTask.title);
  assert.ok(api.state.calls.length>=1);assert.ok(api.state.calls.every(c=>c.method==='GET'));
});

test('offset timestamps normalize to UTC for create, edit and reminder calls',async()=>{
  const offset='2026-11-01T09:00:00+01:00',utc='2026-11-01T08:00:00Z';
  assert.equal(success(await call('create_task',{projectId:1,title:'Offset',dueDate:offset})).due_date,utc);
  success(await call('update_task',{taskId:1,dueDate:offset}));assert.equal(api.state.task.due_date,utc);
  success(await call('set_task_due_date',{taskId:1,dueDate:'2026-11-01T07:00:00-01:00'}));assert.equal(api.state.task.due_date,utc);
  success(await call('set_task_reminders',{taskId:1,reminders:[{reminder:offset}]}));assert.deepEqual(api.state.task.reminders,[{reminder:utc}]);
  for(const dueDate of ['2026-11-01','2026-11-01T09:00:00','2026-02-30T09:00:00Z','2026-11-01T09:00:00+25:00']) {
    const count=api.state.calls.length;assert.equal((await call('set_task_due_date',{taskId:1,dueDate})).isError,true,dueDate);assert.equal(api.state.calls.length,count);
  }
});

test('reminder items require one complete form and valid relative base dates',async()=>{
  for(const reminders of [[{}],[{relativeTo:'due_date'}],[{relativePeriodSeconds:-60}],
    [{reminder:'0001-01-01T00:00:00Z'}],
    [{relativeTo:'due_date',relativePeriodSeconds:-60,reminder:'2027-01-01T00:00:00Z'}],
    [{reminder:'2027-01-01T00:00:00Z',extra:true}],Array.from({length:101},()=>({reminder:'2027-01-01T00:00:00Z'}))]) {
    assert.equal((await call('set_task_reminders',{taskId:1,reminders})).isError,true);
  }
  assert.equal(api.state.calls.length,0);
  for(const base of [undefined,null,'0001-01-01T00:00:00Z']) {
    api.state.task.start_date=base;
    const result=await call('set_task_reminders',{taskId:1,reminders:[{relativeTo:'start_date',relativePeriodSeconds:-60}]});
    assert.equal(result.isError,true);assert.match(result.content[0].text,/start_date is not set/);
  }
  assert.ok(api.state.calls.every(c=>c.method==='GET'));
  success(await call('set_task_reminders',{taskId:1,reminders:[{relativeTo:'due_date',relativePeriodSeconds:-900}]}));
  assert.deepEqual(api.state.task.reminders,[{relative_to:'due_date',relative_period:-900}]);
});

test('project description clearing reports unsupported before applying any other edit',async()=>{
  const result=await call('update_project',{projectId:1,title:'Do not apply',description:''});
  assert.equal(result.isError,true);assert.match(result.content[0].text,/does not support clearing.*No changes were written/);
  assert.deepEqual(api.state.project,originalProject);assert.ok(api.state.calls.every(c=>c.method==='GET'));
  api.state.project.description='';
  const changed=success(await call('update_project',{projectId:1,title:'Already empty',description:''}));
  assert.equal(changed.title,'Already empty');assert.equal(changed.description,'');
});

test('identifier lookup supports backend prefixes, encodes paths and rejects unsafe indices',async()=>{
  for(const prefix of ['9TEAM','UI-WEB','R&D','ČAS','9TEAM-']) {
    success(await call('get_task_by_identifier',{identifier:`${prefix}-1`}));
    assert.equal(api.state.calls.at(-1).path,`/api/v1/projects/${encodeURIComponent(prefix)}/tasks/by-index/1`);
  }
  api.state.calls=[];
  for(const identifier of ['9TEAM-0','9TEAM--','9TEAM-9007199254740992','TOO-LONG-PREFIX-1','9TEAM-1/trick','9TEAM\n-1']) {
    assert.equal((await call('get_task_by_identifier',{identifier})).isError,true,identifier);
  }
  assert.equal(api.state.calls.length,0);
});

test('numeric-only project identifiers resolve to their project IDs before lookup',async()=>{
  api.state.project.identifier='123';api.state.pagination={'X-Pagination-Total-Pages':'1'};
  success(await call('get_task_by_identifier',{identifier:'123-1'}));
  assert.equal(api.state.calls[0].query.get('is_archived'),'true');
  assert.equal(api.state.calls.at(-1).path,'/api/v1/projects/1/tasks/by-index/1');
  api.state.calls=[];
  const result=await call('get_task_by_identifier',{identifier:'456-1'});
  assert.equal(result.isError,true);assert.equal(api.state.calls.length,1);assert.equal(api.state.calls[0].path,'/api/v1/projects');
});

test('authorization, allowed host and Origin checks precede parsing',async()=>{
  assert.equal((await mcp.rpc('tools/list',{}, {headers:{'X-API-Key':''}})).status,401);
  assert.equal((await mcp.rpc('tools/list',{}, {headers:{Origin:'https://untrusted.example'}})).status,403);
  const hostStatus=await new Promise((resolve,reject)=>{
    const request=http.request(`${mcp.url}/mcp`,{method:'POST',headers:{Host:'untrusted.example','X-API-Key':'test-mcp-key','Content-Type':'application/json'}},res=>{res.resume();resolve(res.statusCode);});
    request.once('error',reject);request.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'}));
  });
  assert.equal(hostStatus,403);
  assert.equal((await mcp.rpc('tools/list',{}, {headers:{Origin:mcp.url}})).status,200);
  assert.equal((await mcp.rpc('tools/list',{}, {method:'GET'})).status,405);
  const bad=await fetch(`${mcp.url}/mcp`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{bad'});
  assert.equal(bad.status,401);
});

test('health is minimal and readiness requires an authenticated upstream check',async()=>{
  const health=await fetch(`${mcp.url}/healthz`);assert.deepEqual(await health.json(),{ok:true,name:'vikunja-http'});
  assert.equal((await fetch(`${mcp.url}/readyz`)).status,401);
  assert.equal((await fetch(`${mcp.url}/readyz`,{headers:{'X-API-Key':'test-mcp-key'}})).status,200);
});

test('configured remote origins work and transport request capacity is bounded',async()=>{
  const other=await startMcp(api.url,{VIKUNJA_MCP_ALLOWED_ORIGINS:'https://client.example',VIKUNJA_MCP_MAX_CONCURRENT_REQUESTS:'1'});
  try {
    assert.equal((await other.rpc('tools/list',{}, {headers:{Origin:'https://client.example'}})).status,200);
    api.state.delay=100;
    const first=other.rpc('tools/call',{name:'get_task',arguments:{taskId:1}});
    const deadline=Date.now()+3000;
    while(!api.state.calls.some(c=>c.path==='/api/v1/tasks/1')) {
      assert.ok(Date.now()<deadline,'First upstream request did not start');
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    const busy=await other.rpc('tools/list');assert.equal(busy.status,503);assert.equal(busy.headers.get('retry-after'),'1');
    assert.equal((await first).status,200);assert.equal((await other.rpc('tools/list')).status,200);
  } finally {await other.close();}
});

test('task edits preserve both concurrent changes and unrelated task state',async()=>{
  api.state.delay=25;
  const results=await Promise.all([call('update_task',{taskId:1,title:'Edited'}),call('update_task',{taskId:1,priority:5})]);
  results.forEach(success);
  assert.equal(api.state.task.title,'Edited');assert.equal(api.state.task.priority,5);
  for(const key of ['description','due_date','assignees','reminders','is_favorite']) assert.deepEqual(api.state.task[key],originalTask[key],key);
  const writes=api.state.calls.filter(c=>c.method==='POST');assert.ok(writes.every(c=>c.path==='/api/v1/tasks/bulk'));
  assert.deepEqual(writes.map(c=>c.body.fields),[['title'],['priority']]);
});

test('field-scoped task writes preserve scalar edits made by an external writer',async()=>{
  api.state.beforeWrite=state=>{state.task.description='External edit';state.task.priority=4;};
  success(await call('update_task',{taskId:1,title:'MCP edit'}));
  assert.equal(api.state.task.title,'MCP edit');assert.equal(api.state.task.description,'External edit');assert.equal(api.state.task.priority,4);
});

test('advertised field updates preserve independent task, project and label edits',async()=>{
  api.state.atomicSupport=true;
  const other=await startMcp(api.url,{VIKUNJA_REQUIRE_ATOMIC_UPDATES:'1'});
  const invoke=async(name,args)=>success((await other.rpc('tools/call',{name,arguments:args})).data.result);
  try {
    api.state.beforeWrite=state=>{
      state.task.description='External task';state.task.assignees=[{id:9}];state.task.reminders=[{reminder:'2027-02-01T00:00:00Z'}];state.task.is_favorite=false;
    };
    await invoke('update_task',{taskId:1,title:'Atomic task'});
    assert.equal(api.state.task.description,'External task');assert.deepEqual(api.state.task.assignees,[{id:9}]);assert.equal(api.state.task.is_favorite,false);assert.equal(api.state.task.reminders[0].reminder,'2027-02-01T00:00:00Z');
    api.state.beforeWrite=state=>{state.task.priority=5;};
    await invoke('update_task',{taskId:1,priority:1});assert.equal(api.state.task.priority,1);
    api.state.beforeWrite=state=>{state.project.description='External project';state.project.is_archived=true;};
    await invoke('update_project',{projectId:1,title:'Atomic project'});
    assert.equal(api.state.project.description,'External project');assert.equal(api.state.project.is_archived,true);
    await invoke('update_project',{projectId:1,description:''});assert.equal(api.state.project.description,'');
    api.state.beforeWrite=state=>{state.label.description='External label';state.label.hex_color='abcdef';};
    await invoke('update_label',{labelId:1,title:'Atomic label'});
    assert.equal(api.state.label.description,'External label');assert.equal(api.state.label.hex_color,'abcdef');
    const writes=api.state.calls.filter(c=>c.method==='POST');
    assert.ok(writes.every(c=>c.path.startsWith('/api/v2/') && c.path.endsWith('/fields')));
    assert.deepEqual(writes.map(c=>c.body.update_fields),[['title'],['priority'],['title'],['description'],['title']]);
  } finally {await other.close();}
});

test('an advertised field route failure never falls back to a replacement write',async()=>{
  api.state.atomicSupport=true;
  const other=await startMcp(api.url);
  try {
    for(const status of [404,403,503]) {
      api.state.calls=[];api.state.failWrite=status;
      const result=(await other.rpc('tools/call',{name:'update_task',arguments:{taskId:1,title:'Do not retry'}})).data.result;
      assert.equal(result.isError,true);assert.match(result.content[0].text,/Fixture field route failure/);
      const writes=api.state.calls.filter(c=>c.method==='POST');assert.equal(writes.length,1);assert.equal(writes[0].path,'/api/v2/tasks/1/fields');assert.equal(api.state.task.title,originalTask.title);
    }
  } finally {await other.close();}
});

test('default atomic requirement rejects writes and readiness on an unpatched backend',async()=>{
  const other=await startMcp(api.url);
  try {
    const result=(await other.rpc('tools/call',{name:'update_task',arguments:{taskId:1,title:'Do not write'}})).data.result;
    assert.equal(result.isError,true);assert.match(result.content[0].text,/does not advertise protocol 1/);
    assert.ok(api.state.calls.every(c=>c.method==='GET'));assert.equal(api.state.task.title,originalTask.title);
    assert.equal((await fetch(`${other.url}/readyz`,{headers:{'X-API-Key':'test-mcp-key'}})).status,503);
  } finally {await other.close();}
});

test('queues recover from an upstream failure without replaying the failed edit',async()=>{
  api.state.failWrite=true;api.state.delay=15;
  const firstRequest=call('update_task',{taskId:1,title:'Failed title'});
  const deadline=Date.now()+3000;
  while(!api.state.calls.some(c=>c.path==='/api/v1/tasks/1')) {
    assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,1));
  }
  const [first,second]=await Promise.all([firstRequest,call('update_task',{taskId:1,priority:5})]);
  assert.equal(first.isError,true);success(second);
  assert.equal(api.state.task.title,'Original');assert.equal(api.state.task.priority,5);
});

test('project edits serialize and explicit null parent detaches to zero',async()=>{
  api.state.delay=20;
  const results=await Promise.all([call('update_project',{projectId:1,title:'Edited project'}),call('update_project',{projectId:1,identifier:'NEW',parentProjectId:null})]);
  results.forEach(success);
  assert.equal(api.state.project.title,'Edited project');assert.equal(api.state.project.identifier,'NEW');
  assert.equal(api.state.project.description,'Keep project');assert.equal(api.state.project.parent_project_id,0);
});

test('assignee replacement shares the task edit queue',async()=>{
  api.state.delay=25;
  const result=await Promise.all([call('update_task',{taskId:1,title:'Edited'}),call('set_task_assignees',{taskId:1,userIds:[8]})]);
  result.forEach(success);assert.equal(api.state.task.title,'Edited');assert.deepEqual(api.state.task.assignees,[{id:8}]);
});

test('percentDone converts 0, 50 and 100 to the API fraction',async()=>{
  for(const [percent,fraction] of [[100,1],[50,0.5],[0,0]]) {
    const task=success(await call('update_task',{taskId:1,percentDone:percent}));
    assert.equal(task.percent_done,fraction);assert.equal(api.state.task.percent_done,fraction);
  }
  for(const percentDone of [-1,101]) assert.equal((await call('update_task',{taskId:1,percentDone})).isError,true);
});

test('due dates, repeat settings, completion and reminder replacement preserve other fields',async()=>{
  success(await call('set_task_due_date',{taskId:1,dueDate:null}));assert.equal(api.state.task.due_date,null);
  success(await call('set_task_repeat',{taskId:1,repeatAfterSeconds:86400,repeatMode:2}));assert.equal(api.state.task.repeat_after,86400);
  success(await call('complete_task',{taskId:1}));assert.equal(api.state.task.done,true);
  success(await call('set_task_reminders',{taskId:1,reminders:[]}));assert.deepEqual(api.state.task.reminders,[]);
  assert.equal(api.state.task.title,originalTask.title);assert.deepEqual(api.state.task.assignees,originalTask.assignees);
});

test('repeat modes support explicit stop and zero disables a previously monthly task',async()=>{
  api.state.task.repeat_mode=1;api.state.task.repeat_after=0;
  success(await call('set_task_repeat',{taskId:1,repeatAfterSeconds:0}));assert.equal(api.state.task.repeat_mode,0);
  success(await call('set_task_repeat',{taskId:1,mode:'monthly'}));assert.equal(api.state.task.repeat_mode,1);assert.equal(api.state.task.repeat_after,0);
  success(await call('set_task_repeat',{taskId:1,mode:'fromCompletion',repeatAfterSeconds:86400}));assert.equal(api.state.task.repeat_mode,2);
  success(await call('set_task_repeat',{taskId:1,mode:'none'}));assert.equal(api.state.task.repeat_mode,0);assert.equal(api.state.task.repeat_after,0);
  success(await call('set_task_repeat',{taskId:1,repeatAfterSeconds:0,repeatMode:1}));assert.equal(api.state.task.repeat_mode,1);
  for(const args of [{},{mode:'interval'},{mode:'fromCompletion',repeatAfterSeconds:0},{mode:'monthly',repeatAfterSeconds:1},{mode:'none',repeatMode:0},{repeatAfterSeconds:0,repeatMode:2},{repeatAfterSeconds:315360001}]) {
    const count=api.state.calls.length;assert.equal((await call('set_task_repeat',{taskId:1,...args})).isError,true,JSON.stringify(args));assert.equal(api.state.calls.length,count);
  }
});

test('ordering uses the view-specific endpoint and returns the persisted value',async()=>{
  const result=success(await call('set_task_position',{taskId:1,projectViewId:9,position:100}));
  assert.equal(result.position,100.5);assert.equal(result.project_view_id,9);
  assert.equal(api.state.calls.at(-1).path,'/api/v1/tasks/1/position');
  assert.deepEqual(api.state.calls.at(-1).body,{project_view_id:9,position:100});
  assert.equal((await call('set_task_position',{taskId:1,position:1})).isError,true);
});

test('project and completion filters run before pagination with explicit page coverage',async()=>{
  const first=success(await call('list_tasks',{projectId:2,page:1,perPage:1}));
  assert.equal(first.tasks[0].id,5);assert.deepEqual(first.pagination,{pageItemCount:1,totalPages:2,resultCount:1,page:1,requestedPerPage:1,hasMore:true,nextPage:2,completeness:'partial'});
  const second=success(await call('list_tasks',{projectId:2,page:2,perPage:1}));assert.equal(second.tasks[0].id,6);
  assert.equal(second.pagination.hasMore,false);assert.equal(second.pagination.completeness,'partial');assert.equal(second.pagination.nextPage,undefined);
  const all=success(await call('list_tasks',{projectId:2,includeDone:true}));assert.equal(all.count,3);
  assert.equal(api.state.calls.at(-1).query.get('filter'),'project_id = 2');
});

test('missing or malformed pagination headers stay unknown while zero remains valid',async()=>{
  const unknown={pageItemCount:1,page:1,completeness:'unknown'};
  assert.deepEqual(success(await call('list_projects')).pagination,unknown);
  api.state.pagination={'X-Pagination-Total-Pages':'bad','X-Pagination-Result-Count':'-1'};
  assert.deepEqual(success(await call('list_projects')).pagination,unknown);
  api.state.pagination={'X-Pagination-Total-Pages':'0','X-Pagination-Result-Count':'0'};
  assert.deepEqual(success(await call('list_projects')).pagination,{...unknown,totalPages:0,resultCount:0});
});

test('supported task expansions survive normalization and unknown names fail',async()=>{
  const expansions=['subtasks','buckets','comments','comment_count','time_entries_count','is_unread','reactions'];
  const task=success(await call('get_task',{taskId:1,expand:expansions}));
  for(const field of expansions) assert.ok(field in task,field);
  assert.equal(task.subtasks[0].title,'Child');assert.equal(task.comments[0].comment,'Hi');assert.equal(task.time_entries_count,3);
  assert.deepEqual(api.state.calls.at(-1).query.getAll('expand'),expansions);
  assert.equal((await call('get_task',{taskId:1,expand:['unknown']})).isError,true);
});

test('uploads report successes, partial failures and total failures accurately',async()=>{
  const args={taskId:1,filename:'fixture.txt',contentBase64:Buffer.from('fixture').toString('base64')};
  api.state.upload={success:[{id:77,task_id:1,file:{name:'fixture.txt'}}],errors:null};
  assert.equal(success(await call('upload_task_attachment',args)).attachments[0].id,77);
  api.state.upload.errors=[{code:123,message:'Rejected file'}];
  const partial=success(await call('upload_task_attachment',args));assert.equal(partial.partialSuccess,true);assert.equal(partial.errors[0].message,'Rejected file');
  api.state.upload.success=null;
  const failure=await call('upload_task_attachment',args);assert.equal(failure.isError,true);assert.equal(failure.structuredContent.errors[0].code,123);
  api.state.upload={message:'Unknown response'};assert.equal((await call('upload_task_attachment',args)).isError,true);
});

test('default file access is denied and malformed upload sources never reach upstream',async()=>{
  const before=api.state.calls.length;
  for(const args of [{serverFilePath:'README.md'},{contentBase64:'%%%%'},{contentBase64:'YQ==',serverFilePath:'x'}]) {
    assert.equal((await call('upload_task_attachment',{taskId:1,filename:'fixture.txt',...args})).isError,true);
  }
  assert.equal(api.state.calls.length,before);
});

test('opted-in local imports send only bounded files from the configured directory',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'vikunja-http-import-'));
  const other=await startMcp(api.url,{VIKUNJA_UPLOAD_DIRECTORY:directory,VIKUNJA_MAX_UPLOAD_BYTES:'20'});
  try {
    await writeFile(join(directory,'fixture.txt'),'IMPORT_SENTINEL');
    const result=await other.rpc('tools/call',{name:'upload_task_attachment',arguments:{taskId:1,filename:'fixture.txt',serverFilePath:'fixture.txt'}});
    assert.equal(result.data.result.structuredContent.attachments[0].id,77);
    assert.match(api.state.calls.at(-1).body,/IMPORT_SENTINEL/);
    const before=api.state.calls.length;
    const rejected=await other.rpc('tools/call',{name:'upload_task_attachment',arguments:{taskId:1,filename:'fixture.txt',serverFilePath:'../outside.txt'}});
    assert.equal(rejected.data.result.isError,true);assert.equal(api.state.calls.length,before);
  } finally {await other.close();await rm(directory,{recursive:true,force:true});}
});

test('authorized invalid and oversized JSON return sanitized errors and invalid IDs do not reach upstream',async()=>{
  const headers={'Content-Type':'application/json','X-API-Key':'test-mcp-key'};
  const malformed=await fetch(`${mcp.url}/mcp`,{method:'POST',headers,body:'{bad'});
  assert.equal(malformed.status,400);assert.deepEqual(await malformed.json(),{error:'Invalid JSON request'});
  const oversized=await fetch(`${mcp.url}/mcp`,{method:'POST',headers,body:JSON.stringify({data:'x'.repeat(1024*1024)})});
  assert.equal(oversized.status,413);assert.deepEqual(await oversized.json(),{error:'Request body is too large'});
  const before=api.state.calls.length;
  assert.equal((await call('get_task',{taskId:-1})).isError,true);assert.equal(api.state.calls.length,before);
  assert.equal((await mcp.rpc('tools/list')).status,200);
});

test('compressed JSON is rejected before decompression and the server remains available',async()=>{
  const compressed=gzipSync(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'}));
  const headers={'Content-Type':'application/json','Content-Encoding':'gzip','X-API-Key':'test-mcp-key'};
  for(const body of [compressed,Buffer.concat([compressed,Buffer.from('invalid trailing bytes')])]) {
    const response=await fetch(`${mcp.url}/mcp`,{method:'POST',headers,body});
    assert.equal(response.status,415);
    assert.deepEqual(await response.json(),{error:'Unsupported request encoding'});
  }
  const denied=await fetch(`${mcp.url}/mcp`,{method:'POST',headers:{...headers,'X-API-Key':''},body:compressed});
  assert.equal(denied.status,401);
  assert.equal((await mcp.rpc('tools/list')).status,200);
});

test('timeouts become tool errors and current user fallback behavior is retained',async()=>{
  const short=await startMcp(api.url,{VIKUNJA_TIMEOUT_MS:'30',VIKUNJA_USER_ID:'8',VIKUNJA_USERNAME:'configured'});
  try {
    const timeout=await short.rpc('tools/call',{name:'get_task',arguments:{taskId:999}});
    assert.equal(timeout.data.result.isError,true);assert.match(timeout.data.result.content[0].text,/timed out/);
    const user=await short.rpc('tools/call',{name:'get_current_user',arguments:{}});
    assert.equal(user.data.result.structuredContent.id,8);assert.equal(user.data.result.structuredContent.source,'environment');
  } finally {await short.close();}
});

test('task-label pagination compensates for upstream ignoring per_page without losing labels',async()=>{
  api.state.taskLabels=[{id:7,title:'First'},{id:8,title:'Second'},{id:9,title:'Third'}];
  for(const [page,ids] of [[1,[7]],[2,[8]],[3,[9]],[4,[]]]) {
    const result=success(await call('list_task_labels',{taskId:1,page,perPage:1}));
    assert.deepEqual(result.labels.map(label=>label.id),ids);
    assert.equal(result.count,ids.length);assert.equal(result.pagination.totalPages,3);
    assert.equal(result.pagination.hasMore,page<3);
  }
  const combined=success(await call('list_task_labels',{taskId:1,page:1,perPage:100}));
  assert.deepEqual(combined.labels.map(label=>label.id),[7,8,9]);
  assert.equal(combined.pagination.completeness,'complete');
  assert.ok(api.state.calls.filter(call=>call.path==='/api/v1/tasks/1/labels').every(call=>!call.query.has('per_page')));
});

test('repeated task-label pages fail rather than claim a complete collection',async()=>{
  api.state.taskLabels=[{id:7},{id:8},{id:9}];api.state.repeatLabelPage=true;
  const result=await call('list_task_labels',{taskId:1,page:1,perPage:100});
  assert.equal(result.isError,true);assert.match(result.content[0].text,/repeated IDs/);
});

test('an empty native label page before the reported end is not a complete collection',async()=>{
  api.state.taskLabels=[{id:7},{id:8},{id:9}];api.state.emptyLabelPage=2;
  const result=await call('list_task_labels',{taskId:1,page:1,perPage:100});
  assert.equal(result.isError,true);assert.match(result.content[0].text,/empty page before its reported end/);
});

test('configured current-user fallback omits placeholder identity fields',async()=>{
  for(const placeholder of ['undefined','null','  undefined  ']) {
    const configured=await startMcp(api.url,{VIKUNJA_USER_ID:'8',VIKUNJA_USERNAME:'configured',VIKUNJA_USER_NAME:placeholder,VIKUNJA_USER_EMAIL:placeholder});
    try {
      const response=await configured.rpc('tools/call',{name:'get_current_user',arguments:{}});
      const user=success(response.data.result);
      assert.equal(user.id,8);assert.equal(user.username,'configured');assert.equal(user.source,'environment');
      assert.equal(Object.hasOwn(user,'name'),false);assert.equal(Object.hasOwn(user,'email'),false);
    } finally {await configured.close();}
  }
});
