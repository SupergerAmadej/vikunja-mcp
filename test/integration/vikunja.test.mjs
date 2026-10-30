import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp,writeFile,mkdir,rm,copyFile,cp,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { startMcp,listen,cleanEnv } from '../helpers/harness.mjs';

// This suite never uses a running user instance. It starts a disposable binary
// with a fresh SQLite database and file directory, then removes its own state.
test('Vikunja 2.7.1 API contracts and persistence', {skip:!process.env.TEST_VIKUNJA_BINARY,timeout:90_000},async t=>{
  const binary=resolve(process.env.TEST_VIKUNJA_BINARY);
  const dir=await mkdtemp(join(tmpdir(),'vikunja-integration-'));
  await mkdir(join(dir,'files'));
  const reservation=await listen((_req,res)=>res.end());const url=reservation.url;await reservation.close();
  const configPath=join(dir,'config.yml');await writeFile(configPath,'{}\n');
  const env={...cleanEnv(),VIKUNJA_SERVICE_INTERFACE:new URL(url).host,VIKUNJA_SERVICE_ROOTPATH:dir,VIKUNJA_SERVICE_PUBLICURL:`${url}/`,VIKUNJA_SERVICE_JWTSECRET:`disposable-${randomUUID()}`,VIKUNJA_SERVICE_ENABLEREGISTRATION:'true',VIKUNJA_DATABASE_TYPE:'sqlite',VIKUNJA_DATABASE_PATH:join(dir,'vikunja.db'),VIKUNJA_FILES_BASEPATH:join(dir,'files'),VIKUNJA_LOG_PATH:join(dir,'logs'),VIKUNJA_LOG_DATABASE:'off',VIKUNJA_LOG_LEVEL:'WARNING',VIKUNJA_MAILER_ENABLED:'false'};
  let upstream,mcp,logs='',token;
  async function start() {
    upstream=spawn(binary,['--config',configPath,'web'],{cwd:dir,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    upstream.stdout.on('data',b=>logs+=b);upstream.stderr.on('data',b=>logs+=b);
    const deadline=Date.now()+20_000;
    while(Date.now()<deadline) {
      if(upstream.exitCode!==null) throw new Error(`Vikunja exited ${upstream.exitCode}: ${logs}`);
      try {const response=await fetch(`${url}/api/v1/info`);if(response.ok) return;} catch {}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw new Error(`Vikunja did not start: ${logs}`);
  }
  async function stop() {
    if(upstream?.exitCode===null) {const done=once(upstream,'exit');upstream.kill();await done;}
  }
  async function api(path,method='GET',body,raw=false) {
    const response=await fetch(`${url}/api/v1${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`} : {}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    if(raw) return response;
    const data=await response.json();assert.ok(response.ok,`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);return data;
  }
  async function call(name,args={}) {
    const response=await mcp.rpc('tools/call',{name,arguments:args});assert.equal(response.status,200);
    assert.notEqual(response.data.result?.isError,true,JSON.stringify(response.data));return response.data.result.structuredContent;
  }
  async function rejects(name,args,message) {
    const response=await mcp.rpc('tools/call',{name,arguments:args});assert.equal(response.status,200);
    assert.equal(response.data.result?.isError,true,JSON.stringify(response.data));
    if(message) assert.match(response.data.result.content[0].text,message);
  }
  try {
    await start();
    const info=await api('/info');assert.match(info.version,/2\.7\.1/);
    await api('/register','POST',{username:'integration',password:'integration-password-123!',email:'integration@example.test'});
    token=(await api('/login','POST',{username:'integration',password:'integration-password-123!'})).token;
    const user=await api('/user');
    mcp=await startMcp(url,{VIKUNJA_TOKEN:token,VIKUNJA_REQUIRE_ATOMIC_UPDATES:'0'});
    const project=(await call('create_project',{title:'Integration project',identifier:'TEST',description:'Keep project description'}));
    const task=await call('create_task',{projectId:project.id,title:'Keep task',description:'Keep description',dueDate:'2027-01-01T00:00:00Z'});
    const taskId=task.id;
    const relationTask=await call('create_task',{projectId:project.id,title:'Child task'});
    await t.test('audit regressions reject no-op inputs and unsupported project clearing',async()=>{
      await rejects('update_task',{taskId},/at least one supported field/);
      await rejects('update_task',{taskId,title:'Must not change',startDate:'2027-01-01T00:00:00Z'},/Unrecognized key/);
      assert.equal((await api(`/tasks/${taskId}`)).title,'Keep task');
      await rejects('set_task_reminders',{taskId,reminders:[{}]});
      await rejects('set_task_reminders',{taskId,reminders:[{relativeTo:'start_date',relativePeriodSeconds:-60}]},/start_date is not set/);
      await rejects('update_project',{projectId:project.id,title:'Must not change',description:''},/does not support clearing/);
      const unchanged=await api(`/projects/${project.id}`);assert.equal(unchanged.title,'Integration project');assert.equal(unchanged.description,'Keep project description');
    });
    await t.test('backend-valid identifiers resolve without numeric project confusion',async()=>{
      for(const prefix of ['9TEAM','123','R&D']) {
        const created=await call('create_project',{title:`Identifier ${prefix}`,identifier:prefix});
        const item=await call('create_task',{projectId:created.id,title:'Lookup fixture'});
        assert.equal((await call('get_task_by_identifier',{identifier:item.identifier})).id,item.id);
        await call('delete_project',{projectId:created.id});
      }
    });
    await t.test('offset dates, meaningful reminders and repeat disabling persist correctly',async()=>{
      const offset='2026-11-01T09:00:00+01:00',instant='2026-11-01T08:00:00Z';
      const item=await call('create_task',{projectId:project.id,title:'Scheduling fixture',dueDate:offset});
      assert.equal(Date.parse((await api(`/tasks/${item.id}`)).due_date),Date.parse(instant));
      await call('update_task',{taskId:item.id,dueDate:'2026-11-02T09:00:00+01:00'});
      await call('set_task_due_date',{taskId:item.id,dueDate:offset});
      await call('set_task_reminders',{taskId:item.id,reminders:[{reminder:offset}]});
      assert.equal(Date.parse((await api(`/tasks/${item.id}`)).reminders[0].reminder),Date.parse(instant));
      await call('set_task_reminders',{taskId:item.id,reminders:[{relativeTo:'due_date',relativePeriodSeconds:-900}]});
      const relative=(await api(`/tasks/${item.id}`)).reminders[0];
      assert.equal(relative.relative_to,'due_date');assert.equal(relative.relative_period,-900);assert.equal(Date.parse(relative.reminder),Date.parse(instant)-900_000);
      await call('set_task_repeat',{taskId:item.id,mode:'monthly'});
      await call('set_task_repeat',{taskId:item.id,repeatAfterSeconds:0});
      assert.equal((await api(`/tasks/${item.id}`)).repeat_mode,0);
      await call('set_task_repeat',{taskId:item.id,mode:'monthly'});
      await call('set_task_repeat',{taskId:item.id,mode:'none'});
      const stopped=await api(`/tasks/${item.id}`);assert.equal(stopped.repeat_mode,0);assert.equal(stopped.repeat_after,0);
      await call('set_task_repeat',{taskId:item.id,mode:'interval',repeatAfterSeconds:86400});
      const completed=await call('complete_task',{taskId:item.id});
      const persisted=await api(`/tasks/${item.id}`);assert.equal(completed.done,persisted.done);assert.equal(persisted.done,false);
      assert.equal(Date.parse(persisted.due_date),Date.parse(instant)+86_400_000);
      await call('delete_task',{taskId:item.id});
    });
    await t.test('scalar updates preserve dates, reminders, assignees and favorites',async()=>{
      await call('set_task_assignees',{taskId,userIds:[user.id]});
      await call('set_task_reminders',{taskId,reminders:[{reminder:'2026-12-31T00:00:00Z'}]});
      await api(`/tasks/${taskId}`,'POST',{...await api(`/tasks/${taskId}`),is_favorite:true});
      await Promise.all([call('update_task',{taskId,title:'Changed title'}),call('update_task',{taskId,priority:5,percentDone:50})]);
      const persisted=await api(`/tasks/${taskId}`);
      assert.equal(persisted.title,'Changed title');assert.equal(persisted.priority,5);assert.equal(persisted.percent_done,0.5);
      assert.equal(persisted.description,'Keep description');assert.match(persisted.due_date,/2027-01-01/);
      assert.equal(persisted.assignees[0].id,user.id);assert.equal(persisted.reminders.length,1);
      assert.equal(persisted.is_favorite,true);
      await call('set_task_due_date',{taskId,dueDate:null});assert.match((await api(`/tasks/${taskId}`)).due_date,/0001-01-01/);
    });
    await t.test('filters and expansion values agree with real responses',async()=>{
      const list=await call('list_tasks',{projectId:project.id,perPage:1});assert.equal(list.count,1);assert.ok(list.pagination.totalPages>=2);
      assert.equal(list.pagination.pageItemCount,1);assert.equal(list.pagination.resultCount,1);assert.equal(list.pagination.nextPage,2);assert.equal(list.pagination.hasMore,true);assert.equal(list.pagination.completeness,'partial');
      const completed=await call('create_task',{projectId:project.id,title:'Completed fixture'});
      await call('complete_task',{taskId:completed.id});
      assert.equal((await call('list_tasks',{projectId:project.id})).count,2);
      assert.equal((await call('list_tasks',{projectId:project.id,includeDone:true})).count,3);
      await call('delete_task',{taskId:completed.id});
      await call('create_subtask_relation',{parentTaskId:taskId,subtaskId:relationTask.id});
      await call('add_task_comment',{taskId,comment:'Integration comment'});
      const expanded=await call('get_task',{taskId,expand:['subtasks','comments','comment_count']});
      assert.equal(expanded.subtasks[0].id,relationTask.id);assert.equal(expanded.comments[0].comment,'Integration comment');assert.equal(expanded.comment_count,1);
      const identifier=await call('get_task_by_identifier',{identifier:task.identifier,expand:['comments']});assert.equal(identifier.id,taskId);assert.equal(identifier.comments.length,1);
    });
    let attachmentId;
    await t.test('uploads and view positions use the real response contracts',async()=>{
      const upload=await call('upload_task_attachment',{taskId,filename:'integration.txt',contentBase64:Buffer.from('fixture content').toString('base64')});
      attachmentId=upload.attachments[0].id;assert.ok(attachmentId>0);
      const stored=await api(`/tasks/${taskId}/attachments/${attachmentId}`,'GET',undefined,true);assert.equal(await stored.text(),'fixture content');
      const views=await api(`/projects/${project.id}/views`);assert.ok(views.length>=2);
      const otherBefore=(await api(`/projects/${project.id}/views/${views[1].id}/tasks`)).find(task=>task.id===taskId).position;
      await call('set_task_position',{taskId,projectViewId:views[0].id,position:12345});
      const positioned=await api(`/projects/${project.id}/views/${views[0].id}/tasks`);assert.equal(positioned.find(task=>task.id===taskId).position,12345);
      const otherAfter=(await api(`/projects/${project.id}/views/${views[1].id}/tasks`)).find(task=>task.id===taskId).position;
      assert.equal(otherAfter,otherBefore);
    });
    await t.test('project edits preserve fields and support unparenting',async()=>{
      await Promise.all([call('update_project',{projectId:project.id,title:'Changed project'}),call('update_project',{projectId:project.id,identifier:'NEW'})]);
      const persisted=await api(`/projects/${project.id}`);assert.equal(persisted.title,'Changed project');assert.equal(persisted.identifier,'NEW');
      assert.equal(persisted.description,'Keep project description');
      const parent=await call('create_project',{title:'Parent project'});
      await call('update_project',{projectId:project.id,parentProjectId:parent.id});
      assert.equal((await api(`/projects/${project.id}`)).parent_project_id,parent.id);
      await call('update_project',{projectId:project.id,parentProjectId:null});
      assert.equal((await api(`/projects/${project.id}`)).parent_project_id,0);
      await call('delete_project',{projectId:parent.id});
    });
    await t.test('labels, comments, relations, assignments and task lifecycle round trip',async()=>{
      const label=await call('create_label',{title:'Label',description:'Keep label',hexColor:'aabbcc'});
      await call('update_label',{labelId:label.id,title:'Changed label'});
      const updatedLabel=await api(`/labels/${label.id}`);assert.equal(updatedLabel.title,'Changed label');assert.equal(updatedLabel.hex_color,'aabbcc');assert.equal(updatedLabel.description,'Keep label');
      await call('add_task_label',{taskId,labelId:label.id});
      assert.equal((await call('list_task_labels',{taskId})).labels[0].id,label.id);
      await call('replace_task_labels',{taskId,labelIds:[]});assert.equal((await call('list_task_labels',{taskId})).count,0);
      await call('add_task_label',{taskId,labelId:label.id});await call('remove_task_label',{taskId,labelId:label.id});await call('delete_label',{labelId:label.id});
      const comment=await call('add_task_comment',{taskId,comment:'Edit me'});
      await call('update_task_comment',{taskId,commentId:comment.id,comment:'Edited comment'});
      assert.ok((await call('list_task_comments',{taskId})).comments.some(c=>c.comment==='Edited comment'));
      await call('delete_task_comment',{taskId,commentId:comment.id});
      await call('remove_subtask_relation',{parentTaskId:taskId,subtaskId:relationTask.id});
      await call('create_task_relation',{taskId,otherTaskId:relationTask.id,relationKind:'related'});
      assert.ok((await call('list_task_relations',{taskId})).relations.related.some(task=>task.id===relationTask.id));
      await call('remove_task_relation',{taskId,otherTaskId:relationTask.id,relationKind:'related'});
      await call('set_task_assignees',{taskId,userIds:[]});assert.equal((await call('list_task_assignees',{taskId})).count,0);
      await call('set_task_reminders',{taskId,reminders:[]});assert.equal(((await api(`/tasks/${taskId}`)).reminders??[]).length,0);
      await call('set_task_repeat',{taskId:relationTask.id,repeatAfterSeconds:86400,repeatMode:2});
      await call('complete_task',{taskId:relationTask.id});assert.equal((await api(`/tasks/${relationTask.id}`)).repeat_after,86400);
      const destination=await call('create_project',{title:'Destination'});
      await call('move_task_to_project',{taskId:relationTask.id,projectId:destination.id});assert.equal((await api(`/tasks/${relationTask.id}`)).project_id,destination.id);
      await call('delete_task',{taskId:relationTask.id});await call('delete_project',{projectId:destination.id});
    });
    await t.test('database and attachment data survive server recreation',async()=>{
      await stop();await start();
      assert.equal((await api(`/tasks/${taskId}`)).title,'Changed title');
      const attachment=await api(`/tasks/${taskId}/attachments/${attachmentId}`,'GET',undefined,true);assert.equal(await attachment.text(),'fixture content');
    });
    await t.test('a cold backup restores task and attachment data in separate paths',async()=>{
      await stop();
      const restored=join(dir,'restored');await mkdir(restored);
      // Windows terminates a child without Unix's graceful signal handling;
      // preserve the entire stopped SQLite file set, including any WAL.
      for(const file of (await readdir(dir)).filter(name=>/^vikunja\.db(?:-wal|-shm)?$/.test(name))) {
        await copyFile(join(dir,file),join(restored,file));
      }
      await cp(join(dir,'files'),join(restored,'files'),{recursive:true});
      env.VIKUNJA_DATABASE_PATH=join(restored,'vikunja.db');env.VIKUNJA_FILES_BASEPATH=join(restored,'files');
      await start();
      assert.equal((await api(`/tasks/${taskId}`)).title,'Changed title');
      const attachment=await api(`/tasks/${taskId}/attachments/${attachmentId}`,'GET',undefined,true);assert.equal(await attachment.text(),'fixture content');
      await call('delete_task_attachment',{taskId,attachmentId});
      assert.equal((await call('list_task_attachments',{taskId})).count,0);
    });
  } finally {
    await mcp?.close();await stop();await rm(dir,{recursive:true,force:true});
  }
});
