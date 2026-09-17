const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has('key')) {
  sessionStorage.setItem('relay-local-key', fragment.get('key'));
  history.replaceState(null, '', location.pathname);
}
const key = sessionStorage.getItem('relay-local-key') || '';
let state = null, teamState = null, connected = false, stopped = false, refreshing = false;
let view = 'agent', teamView = 'context', teamProject = '', adding = false, joining = false;
let pairTimer = null, sessions = [], connectionSignature = '', teamSignature = '';
let repositoriesLoaded=false, choosingConversation=false, teamLoading=false;
const pendingButtons=new WeakSet();
try { const saved=JSON.parse(sessionStorage.getItem('relay-view')||'{}'); if(['agent','team'].includes(saved.view))view=saved.view; if(['context','questions','activity'].includes(saved.teamView))teamView=saved.teamView; teamProject=saved.project||''; } catch {}
function rememberView(){sessionStorage.setItem('relay-view',JSON.stringify({view,teamView,project:teamProject}));}

async function api(name, data) {
  if(!key)throw Error('Open the Relay app again to access this computer. A copied browser address does not include its private connection key.');
  const response = await fetch('/api/' + name, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {Authorization:'Bearer '+key, 'Content-Type':'application/json', 'X-Relay-Client':'web'},
    body: data === undefined ? undefined : JSON.stringify(data)
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Could not complete this step.');
  return result;
}
function error(message) { $('#error').textContent=message; $('#error').hidden=!message; }
function notice(message) { $('#notice').textContent=message; $('#notice').hidden=!message; }
async function busy(button, fn) {
  if(pendingButtons.has(button))return;pendingButtons.add(button);
  const text=button.textContent; button.disabled=true; button.textContent='Working…'; error('');
  try { await fn(); } catch(e) { error(e.message); $('#error').focus(); }
  finally { pendingButtons.delete(button);button.disabled=false; button.textContent=text; }
}
function openDetail(html) {
  $('#detail-body').innerHTML=html;
  if (!$('#detail').open) $('#detail').showModal();
}
$('#close-detail').onclick=()=>$('#detail').close();

function layout() {
  const signedIn=!!(state?.member||state?.saved_workspace||state?.connections.length);
  $('#navigation').hidden=!signedIn;
  $('#workspace').hidden=signedIn&&!joining;
  $('#connections').hidden=!signedIn||view!=='agent'||!state.connections.length||adding||joining;
  $('#choose').hidden=!state?.member||view!=='agent'||joining||(state.connections.length>0&&!adding);
  $('#team').hidden=!signedIn||view!=='team';
  $('#page-title').textContent=view==='team'?'Team workspace':signedIn&&state.connections.length&&!adding?'My agent':'Connect your agent';
  $('#page-subtitle').textContent=view==='team'?'See what teammates know, ask a question, and follow shared work.':state?.member?'Connected as '+state.member+'. Choose what your team can see.':signedIn?'Your setup is saved. Reconnect to the workspace to continue.':'Join your workspace, then choose one conversation to share.';
  $('#setup-steps').hidden=view!=='agent'||(signedIn&&state.connections.length>0&&!adding&&!joining)||!!state?.network_error;
  const step=!signedIn||joining?0:choosingConversation?2:1;
  $('#setup-steps').querySelectorAll('li').forEach((li,i)=>{li.classList.toggle('current',i===step);if(i===step)li.setAttribute('aria-current','step');else li.removeAttribute('aria-current');});
  $('#cancel-connection').hidden=!adding;
  $('#cancel-join').hidden=!signedIn;
  $('#select-form').hidden=choosingConversation;
  $('#session-area').hidden=!choosingConversation;
  $('#choose-title').textContent=choosingConversation?'Which conversation should the team see?':'Where are you coding?';
  $('#nav-agent').setAttribute('aria-current',view==='agent'?'page':'false');
  $('#nav-team').setAttribute('aria-current',view==='team'?'page':'false');
}
function preserveDetails(root, render){
  const opened=[...root.querySelectorAll('details[open][data-detail]')].map(d=>d.dataset.detail);
  render();root.querySelectorAll('details[data-detail]').forEach(d=>{d.open=opened.includes(d.dataset.detail);});
}
function renderConnections() {
  const signature=JSON.stringify([state.connections,!!state.member]);
  if(signature===connectionSignature)return;
  connectionSignature=signature;
  const labels={watching:'Sharing on',summarizing:'Updating context',answering:'Answering a question',paused:'Sharing paused',connecting:'Connecting',offline:'Offline',error:'Needs attention','budget-limited':'Hourly limit reached'};
  preserveDetails($('#connections'),()=>{
  $('#connections').innerHTML='<div class="row"><h2>My conversations</h2><button id="add-connection" '+(!state.member?'disabled':'')+'>Connect another</button></div>'+state.connections.map(c=>
    '<article class="card connection"><div class="row"><h3>'+esc(c.name)+'</h3><span class="status">'+esc(c.enabled&&c.worker_online===false&&c.status==='watching'?'Waiting for this computer':labels[c.status]||c.status)+'</span></div>'+
    '<p>'+(c.provider==='claude'?'Claude Code':c.provider==='codex'?'Codex':'Saved connection')+'</p>'+
    (c.error?'<p class="warning">'+esc(c.error)+'</p>':'')+
    '<p class="small">'+(c.agent_online?(c.agent_tool_used?'Agent tools connected · successful tool use verified.':'Agent link connected · ready for a tool check.'):c.agent_tool_used?'Agent currently offline · tools worked previously.':c.tools_configured?'Agent access registered · waiting for your coding client.':'Next: let your coding agent read context, ask teammates, and share plans.')+'</p>'+
    '<div class="actions"><button data-tools="'+esc(c.id)+'" '+(!c.tools_configured&&!c.agent_online?'class="primary" ':'')+(c.reachable===false?'disabled':'')+'>'+(c.agent_online?'Agent connection':c.tools_configured||c.agent_tool_used?'Finish agent connection':'Enable agent tools')+'</button>'+
    '<button data-toggle="'+esc(c.id)+'" data-enabled="'+!c.enabled+'" '+(c.reachable===false?'disabled':'')+'>'+(c.enabled?'Pause sharing':'Resume sharing')+'</button></div>'+
    '<details data-detail="connection-'+esc(c.id)+'"><summary>Details and troubleshooting</summary><p class="small">'+esc(c.repo)+'</p><p class="small">Sharing updates the team dashboard. Agent tools let your coding client use that context. Work coordination remains advisory and does not block edits.</p>'+
    (c.status==='summarizing'?'<p class="small">Relay is preparing a summary after a completed turn. Keep coding; the summary will appear in Team workspace when ready.</p>':'')+'</details></article>').join('');
  });
  $('#add-connection').onclick=()=>busy($('#add-connection'),async()=>{adding=true;invalidateSelection();layout();await loadRepositories();$('#repo').focus();});
  document.querySelectorAll('[data-toggle]').forEach(button=>button.onclick=()=>busy(button,async()=>{
    await api('toggle',{id:button.dataset.toggle,enabled:button.dataset.enabled==='true'});await refresh();
  }));
  document.querySelectorAll('[data-tools]').forEach(button=>button.onclick=()=>{
    const c=state.connections.find(item=>item.id===button.dataset.tools);
    if(c.agent_online){
      openDetail('<h2>Your agent link is connected</h2><p>'+(c.agent_tool_used?'Relay has received a successful tool call from this connection.':'Relay is receiving the coding connector’s heartbeat. To verify tool access, ask your agent to read the team context through Relay.')+'</p><p>No reinstallation is needed. Sharing and agent-tool access are separate connections. Work coordination remains advisory; connection alone does not mean a work plan has been agreed.</p>');return;
    }
    if(c.tools_configured||c.agent_tool_used){
      openDetail('<h2>Finish connecting your coding agent</h2><p>No recent coding-client connection has been detected.</p><ol><li>Reconnect or reopen your coding client.</li><li>Check its MCP tools list for Relay.</li><li>Ask your agent: “Use Relay to read our team context. Tell me if its tools are unavailable.”</li></ol><p class="small">Relay detects the connection automatically. Successful tool use is shown separately from registration. Connection alone does not mean your agent is participating in work coordination.</p>');return;
    }
    openDetail('<h2>Let your coding agent ask the team</h2><p>This adds one Relay MCP server to '+
      (c.provider==='claude'?'Claude Code’s local settings for this repository':'your user-level Codex settings')+
      '. Its tools can read shared context, ask questions, publish plans and reserve work through Relay under your identity. Work coordination is advisory, not an edit gate.</p>'+
      '<p>Your coding client keeps its normal approval rules. No unrelated settings are changed. Reconnect the client after registration.</p>'+
      '<button class="primary" id="approve-tools">Enable agent tools</button><p id="tools-error" role="alert"></p>');
    $('#approve-tools').onclick=async()=>{
      const b=$('#approve-tools');b.disabled=true;$('#tools-error').textContent='';
      try{const result=await api('enable-tools',{id:c.id,consent:true});$('#detail').close();notice(result.message);await refresh();}
      catch(e){$('#tools-error').textContent=e.message;}finally{b.disabled=false;}
    };
  });
}
async function loadRepositories(){
  if(repositoriesLoaded)return;
  const rows=await api('repositories',{});repositoriesLoaded=true;
  $('#repos').innerHTML=rows.map(r=>'<option value="'+esc(r.path)+'">'+esc(r.name)+'</option>').join('');
  if(!$('#repo').value&&rows.length)$('#repo').value=rows[0].path;
}
async function refresh() {
  if(stopped||refreshing)return;
  refreshing=true;
  try{
    state=await api('state');
    if(!$('#url').value)$('#url').value=state.workspace;
    if(state.member){
      const selected=$('#project').value,options=state.projects.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join('');
      if($('#project').innerHTML!==options){$('#project').innerHTML=options;if(state.projects.some(p=>p.id===selected))$('#project').value=selected;}
      $('#project').hidden=state.projects.length===1;$('label[for="project"]').hidden=state.projects.length===1;
      $('#project-empty').hidden=state.projects.length>0;
      const findButton=$('#select-form button[type=submit]');
      findButton.disabled=!state.projects.length||pendingButtons.has(findButton);
    }
    if(state.member&&!connected){
      connected=true;
      if(!state.connections.length)await loadRepositories();
    }
    if(state.member||state.saved_workspace||state.connections.length)renderConnections();
    layout();
    $('#network-status').hidden=!state.network_error;
    $('#network-message').textContent=state.network_error||'';
    if(state.network_error&&view==='team')$('#team-freshness').textContent='Connection interrupted. Any context shown below is the last loaded snapshot.';
    if(view==='team'&&state.member)await refreshTeam();
  }finally{refreshing=false;}
}
async function refreshTeam(){
  if(teamLoading)return;teamLoading=true;
  try{
  teamState=await api('team',{});
  $('#team-freshness').textContent='Updates automatically. Last checked '+new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})+'.';
  if(!teamState.projects.some(p=>p.id===teamProject))teamProject=teamState.projects[0]?.id||'';
  const choices=teamState.projects.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+'</option>').join('');
  if($('#team-project').innerHTML!==choices)$('#team-project').innerHTML=choices;
  $('#team-project').value=teamProject;
  $('#team-project').hidden=teamState.projects.length===1;
  $('label[for="team-project"]').hidden=teamState.projects.length===1;
  rememberView();
  const signature=JSON.stringify([teamState.team,teamState.features,teamState.questions,teamState.observations,teamState.coordination,teamState.bindings.map(b=>[b.session_id,b.enabled,b.worker_online,b.status])])+teamProject+teamView+$('#team-search').value;
  if(signature!==teamSignature){teamSignature=signature;renderTeam();}
  }catch(e){$('#team-freshness').textContent='Could not update. Any context below is the last loaded snapshot.';throw e;}
  finally{teamLoading=false;}
}
function renderTeam(){
  if(!teamState)return;
  const filter=$('#team-search').value.toLowerCase(), matches=item=>item.project_id===teamProject;
  const opened=[...$('#team-body').querySelectorAll('details[open][data-detail]')].map(d=>d.dataset.detail);
  if(teamView==='context'){
    const features=teamState.features.filter(matches).filter(f=>(f.title+' '+f.checkpoint.summary).toLowerCase().includes(filter));
    $('#team-body').innerHTML=features.map(f=>'<article class="card"><div class="row"><h3>'+esc(f.title)+'</h3><span class="status">v'+f.version+'</span></div>'+
      '<p class="small">'+esc(f.owner)+' · '+(f.checkpoint.origin==='agent-derived'?'Agent-derived context':f.checkpoint.origin==='pending'?'Waiting for first summary':'Saved context')+'</p>'+
      '<p>'+esc(String(f.checkpoint.summary||'').slice(0,1200))+'</p><button data-feature="'+esc(f.id)+'">Read context / Ask</button></article>').join('')||
      (filter?'<div class="card"><h2>No matching context</h2><p>Try another word, or clear your search to see all shared features.</p></div>':'<div class="card"><h2>No shared context here yet</h2><p>Connect a conversation in My agent, or wait for its first completed turn.</p></div>');
    document.querySelectorAll('[data-feature]').forEach(b=>b.onclick=()=>featureDetail(b.dataset.feature));
    renderCoordination();
  }else if(teamView==='questions'){
    $('#team-body').innerHTML=teamState.questions.filter(matches).filter(q=>(q.body+' '+q.answer).toLowerCase().includes(filter)).map(q=>'<article class="card"><span class="status">'+
      questionStatus(q).label+'</span>'+
      '<h3>'+esc(q.body)+'</h3><p class="small">'+esc(q.author)+' asked '+esc(q.recipient_name)+'</p><p>'+
      esc(q.answer||q.job?.error||questionStatus(q).help)+'</p>'+
      (q.evidence?'<details><summary>Evidence</summary><p>'+esc(q.evidence)+'</p></details>':'')+'</article>').join('')||
      (filter?'<div class="card"><h2>No matching questions</h2><p>Try another word or clear the search.</p></div>':'<div class="card"><h2>No questions yet</h2><p>Open a shared feature and ask about its decisions or implementation.</p></div>');
  }else{
    const liveNames=new Map((teamState.coordination?.live_sessions||[]).map(s=>[s.session_id,s.name]));
    const activity=[...teamState.observations,...(teamState.coordination?.live_activity||[]).map(e=>({...e,id:'live-'+e.id,session_name:liveNames.get(e.session_id)||'Live session'}))].sort((a,b)=>b.created-a.created);
    $('#team-body').innerHTML=activity.filter(matches).filter(o=>(o.body+' '+o.session_name+' '+o.author).toLowerCase().includes(filter)).slice(0,80).map(o=>'<details data-detail="activity-'+esc(o.id)+'" class="card activity"><summary>'+
      esc(o.author)+' · '+esc(o.kind)+' · '+esc(o.session_name)+'</summary><pre>'+esc(o.body)+'</pre></details>').join('')||
      '<p class="card">'+(filter?'No matching activity. Try another word or clear the search.':'No shared activity yet.')+'</p>';
  }
  $('#team-body').querySelectorAll('details[data-detail]').forEach(d=>{d.open=opened.includes(d.dataset.detail);});
}
function questionStatus(q){
  const b=teamState.bindings.find(b=>b.session_id===q.recipient_id);
  if(q.answer)return {label:'Answered',help:''};
  if(!q.job)return {label:'Waiting for developer',help:'This saved session has no automatic responder. Its developer needs to answer in the workspace.'};
  if(q.job.status==='failed')return {label:'Needs attention',help:'The source could not answer. Its developer can retry from the workspace.'};
  if(!b?.enabled)return {label:'Sharing paused',help:'The question is saved. Its owner needs to resume sharing before Relay can answer.'};
  if(!b.worker_online)return {label:'Waiting for teammate’s computer',help:'The question is saved and will be processed when that computer reconnects.'};
  return {label:q.job.status==='running'?'Agent answering':'Question queued',help:'The source agent is preparing an answer. You can keep working.'};
}
function renderCoordination(){
  const coordination=teamState.coordination, query=$('#team-search').value.toLowerCase();
  const plans=(coordination?.plans||[]).filter(p=>p.project_id===teamProject&&p.status!=='released'&&(p.title+' '+p.plan+' '+p.owner).toLowerCase().includes(query));
  const teamWorkers=new Set((teamState.team?.workers||[]).map(w=>w.session_id));
  const live=(coordination?.live_sessions||[]).filter(s=>s.project_id===teamProject&&!teamWorkers.has(s.session_id));
  if(!plans.length&&!live.length){renderTeamGoals();return;}
  const panel=document.createElement('section');panel.className='card';panel.setAttribute('aria-label','Work coordination');
  const names=new Map((coordination.plans||[]).map(p=>[p.id,p.owner+' / '+p.title]));
  const unplanned=(coordination.unplanned_sessions||[]).filter(s=>s.project_id===teamProject);
  panel.innerHTML='<h2>Working together</h2><p class="small">'+(live.length?'Ordinary agent connections remain advisory. Live working sessions are listed separately below.':'Advisory coordination preview. Local edits are not blocked; agents must use Relay tools. No automatic merging.')+'</p>'+
    (live.length?'<h3>Live working sessions</h3><p class="small">These new sessions use guarded Relay file tools. Pause or quit them in their live terminals. External terminals, editors and ordinary agent conversations are not intercepted. No automatic merging.</p>'+live.map(s=>'<p><strong>'+esc(s.owner)+'</strong> · '+esc(s.name)+' <span class="status">'+(s.online?'Live':s.state==='paused'?'Paused':s.state==='left'?'Stopped':'Offline')+'</span></p>').join('')+
    '<details data-detail="live-activity"><summary>Live agent activity</summary>'+(coordination.live_activity||[]).filter(e=>e.project_id===teamProject).slice(0,30).reverse().map(e=>'<p class="small"><strong>'+esc(e.author)+' · '+esc(e.kind)+'</strong><br>'+esc(e.body)+'</p>').join('')+'</details>':'')+
    (unplanned.length?'<p class="small">'+unplanned.length+' registered session(s) have no open plan and are not participating. Sharing context alone does not enable coordination.</p>':'')+
    plans.map(p=>{
      const status=p.revoked||p.stale?'Needs attention':p.status==='paused'?'Paused':p.blockers?.length?'Coordinating':p.status==='working'?'Working':p.status==='review'?'Ready for integration':'Plan shared';
      return '<article class="card"><div class="row"><h3>'+esc(p.title)+'</h3><span class="status">'+status+'</span></div><p class="small">'+esc(p.owner)+' · Plan v'+p.revision+'</p>'+
        (p.stale?'<p>Computer has not checked in. Its reservation is still held.</p>':'')+
        (p.revoked?'<p>This developer no longer has workspace access. Existing reservations have not been freed.</p>':'')+
        (p.blockers||[]).map(b=>'<p class="small">'+esc(b.note||(b.kind==='reserved'?'Reserved by '+(names.get(b.work_id)||'a teammate'):b.kind==='needs_peer_review'?'Waiting for review from '+(names.get(b.work_id)||'a teammate'):b.kind.replaceAll('_',' ')))+'</p>').join('')+
        '<details data-detail="work-'+esc(p.id)+'"><summary>Plan and agent discussion</summary><p>'+esc(p.plan)+'</p><p class="small">Paths: '+esc(p.paths.join(', '))+'<br>Shared interfaces: '+esc(p.contracts.join(', ')||'None declared')+'<br>Starting commit: '+esc(p.base_commit)+'</p>'+
        (p.result?'<p>Agent-reported result: '+esc(p.result)+'</p>':'')+
        (coordination.messages||[]).filter(m=>m.work_id===p.id).slice(0,20).reverse().map(m=>{
          const receipts=(coordination.deliveries||[]).filter(d=>d.message_id===m.id);
          return '<p class="small"><strong>'+esc(m.author)+' · '+esc(m.kind)+'</strong><br>'+esc(m.body)+(receipts.length?'<br>'+receipts.filter(d=>d.acknowledged).length+'/'+receipts.length+' acknowledged · '+receipts.filter(d=>d.delivered&&!d.acknowledged).length+' delivered, awaiting acknowledgement':'')+'</p>';
        }).join('')+'</details></article>';
    }).join('');
  if((teamState.team?.goals||[]).some(g=>g.project_id===teamProject)){
    const older=document.createElement('details');older.dataset.detail='other-shared-sessions';
    const summary=document.createElement('summary');summary.textContent='Other shared conversations and advisory sessions';
    older.append(summary,panel);$('#team-body').prepend(older);
  }else $('#team-body').prepend(panel);
  renderTeamGoals();
}

function renderTeamGoals(){
  const team=teamState.team;
  if(!team)return;
  const goals=(team.goals||[]).filter(g=>g.project_id===teamProject);
  const names=new Map((team.workers||[]).map(w=>[w.session_id,w.owner]));
  const labels={queued:'Waiting for dependencies or capacity',assigned:'Assigned',working:'Working',review:'Independent review',integration:'Ready for integration and checks',complete:'Verified',blocked:'Needs a decision'};
  const panel=document.createElement('section');panel.className='card';panel.setAttribute('aria-label','Shared goals');
  const startCommand=teamState.team_command||'relay-workspace team';
  if(!goals.length){
    panel.innerHTML='<h2>Start team coding</h2><p>Give your agents one shared goal. Relay assigns the work, coordinates reviews, and can test and merge it on an isolated branch.</p><ol><li>Open a terminal in your coding repository.</li><li>Run this command, confirm the folder, and choose your agent.</li><li>Create a goal; your teammate runs Relay and joins that same goal.</li></ol><p><code>'+esc(startCommand)+'</code></p><button data-team-start>Copy start command</button><p class="small">No existing conversation picker or MCP setup. Automation asks for approval before tests or helpers start. Keep the team terminal open; use this page to follow progress.</p>';
    $('#team-body').prepend(panel);
    panel.querySelector('[data-team-start]').onclick=async()=>{try{await navigator.clipboard.writeText(startCommand);notice('Start command copied.');}catch{notice('Select and copy the command above.');}};
    return;
  }
  panel.innerHTML='<h2>Shared goals</h2><p class="small">Relay assigns tasks and reviews automatically. Existing conversations are not recruited. Only verified, integrated work counts as complete.</p><details><summary>Start a new goal</summary><p>Run this as one line at your normal terminal prompt from the repository you want to work on. Confirm the folder, then choose a new shared goal.</p><p><code>'+esc(startCommand)+'</code></p><button data-team-start>Copy start command</button></details>'+goals.map(g=>{
    const tasks=(team.tasks||[]).filter(t=>t.goal_id===g.id),done=tasks.filter(t=>t.status==='complete').length;
    const questions=(team.questions||[]).filter(q=>q.goal_id===g.id&&!q.response_request);
    const automation=(team.automation||[]).find(a=>a.goal_id===g.id);
    const workers=(team.workers||[]).filter(w=>w.goal_id===g.id);
    const unavailable=workers.filter(w=>w.state!=='active'||Date.now()/1000-w.seen>30);
    const join=startCommand+' --goal '+g.id;
    return '<article><div class="row"><h3>'+esc(g.title)+'</h3><span class="status">'+esc(g.status)+'</span></div><p>'+esc(g.objective)+'</p>'+
      questions.map(q=>'<p><strong>Needs your decision:</strong> '+esc(q.body)+'</p><p class="small">Reply in your team terminal. Work waits for the updated plan.</p>').join('')+
      '<p class="small">'+done+' / '+tasks.length+' tasks verified'+(g.status!=='complete'&&g.planned_revision<g.revision?' · Planning latest requirements':'')+'</p>'+
      (g.status==='complete'?'<p><strong>Work complete.</strong> Results are retained. Review the integration branch before merging or publishing. You can close the team terminals with <code>/quit</code>.</p>':
        '<p class="small">'+(workers.length?workers.map(w=>esc(w.owner)+' · '+esc(w.name)+' — '+(w.state==='active'?(Date.now()/1000-w.seen>30?'offline':'connected'):esc(w.state))).join('<br>'):'Waiting for agents to join this goal.')+'</p>'+
        (unavailable.length?'<p class="small">Connection trouble does not erase work or release ownership. Relay retries brief network outages. If paused, use <code>/resume</code> in that agent’s existing team terminal; do not start a duplicate session.</p>':''))+
      (automation?'<p><strong>Automatic tests and integration</strong><br>Local branch: <code>'+esc(automation.policy.branch)+'</code></p><p class="small">Approved checks: '+esc(automation.policy.test_argv.join(' '))+'. Your original branch is unchanged; nothing is pushed.</p>':'<p class="small">Manual integration. The goal owner runs checks and accepts results.</p>')+
      (g.status==='active'?'<details data-detail="join-'+esc(g.id)+'"><summary>Join this goal</summary><p><code>'+esc(join)+'</code></p><button data-team-join="'+esc(g.id)+'">Copy join command</button><p class="small">Paste as one line at your normal terminal prompt, not inside a running Relay session. On another OS, use <code>relay-workspace team --goal '+esc(g.id)+' --url YOUR_TEAM_ADDRESS</code>. Confirm that PC’s own repository root.</p></details>':'')+
      tasks.map(t=>{
        const integration=(team.integrations||[]).find(i=>i.task_id===t.id);
        const label=integration?.status==='failed'&&t.status==='integration'?'Checks stopped — needs attention':labels[t.status]||t.status;
        return '<details data-detail="team-task-'+esc(t.id)+'"><summary>'+esc(t.title)+' — '+esc(label)+(t.assignee?' · '+esc(names.get(t.assignee)||'Assigned agent'):'')+'</summary><p>'+esc(t.acceptance)+'</p><p class="small">Scope: '+esc(t.paths.join(', '))+'</p>'+
          (t.result?'<p>'+esc(t.result)+'</p>':'')+(t.review_note?'<p>Review: '+esc(t.review_note)+'</p>':'')+
          (integration?'<p><strong>Checks: '+esc(integration.status)+'</strong></p>'+(integration.receipt.error?'<p>'+esc(integration.receipt.error)+'</p>':'')+(integration.receipt.commit?'<p class="small">Integrated commit: <code>'+esc(integration.receipt.commit)+'</code></p>':'')+(integration.status==='failed'&&t.status==='integration'?'<p class="small">Inspect the preserved candidate and run <code>/retry '+esc(t.id)+'</code> in the owner’s team terminal.</p>':''):'')+
          (t.status==='integration'&&integration?.status!=='failed'?'<p class="small">'+(automation?'Waiting for the owner’s automatic checks. Keep that team terminal running.':'Goal owner: <code>/export '+esc(t.id)+'</code>, integrate and test, then <code>/accept '+esc(t.id)+'</code>.')+'</p>':'')+'</details>';
      }).join('')+'</article>';
  }).join('');
  $('#team-body').prepend(panel);
  panel.querySelector('[data-team-start]').onclick=async()=>{try{await navigator.clipboard.writeText(startCommand);notice('Start command copied. Paste it at your normal terminal prompt.');}catch{notice('Select and copy the command above.');}};
  panel.querySelectorAll('[data-team-join]').forEach(button=>button.onclick=async()=>{try{await navigator.clipboard.writeText(startCommand+' --goal '+button.dataset.teamJoin);notice('Join command copied.');}catch{notice('Select and copy the command above.');}});
}
function featureDetail(id){
  const f=teamState.features.find(item=>item.id===id);if(!f)return;
  const sections=[['summary','Implementation'],['decisions','Decisions'],['constraints','Constraints'],['rejected','Rejected approaches'],['assumptions','Assumptions'],['tests','Verification'],['questions','Open questions'],['evidence','Evidence']];
  openDetail('<h2>'+esc(f.title)+'</h2><p class="small">'+esc(f.owner)+' · Version '+f.version+' · '+esc(f.checkpoint.origin||'recorded')+'</p>'+
    sections.filter(([k])=>f.checkpoint[k]).map(([k,label])=>'<h3>'+label+'</h3><p>'+esc(f.checkpoint[k])+'</p>').join('')+
    '<form id="ask-form"><label for="question">Ask the source agent</label><textarea id="question" required maxlength="6000" placeholder="Why was this approach chosen?"></textarea>'+
    '<p class="small">Your question is shared with the workspace. The owning PC answers from an explanation fork; this does not authorize code changes.</p>'+
    '<button class="primary" type="submit">Send question</button><p id="ask-error" role="alert"></p></form>');
  $('#ask-form').onsubmit=async event=>{
    event.preventDefault();const b=$('#ask-form button');b.disabled=true;
    try{await api('ask',{feature_id:id,question:$('#question').value});$('#detail').close();teamView='questions';setTeamTabs();notice('Question sent to the source agent. Its answer will appear here.');await refreshTeam();}
    catch(e){$('#ask-error').textContent=e.message;}finally{b.disabled=false;}
  };
}
function setTeamTabs(){document.querySelectorAll('[data-team-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.teamView===teamView)));}
$('#nav-agent').onclick=()=>{view='agent';rememberView();notice('');layout();};
$('#nav-team').onclick=()=>busy($('#nav-team'),async()=>{view='team';notice('');layout();await refreshTeam();});
document.querySelectorAll('[data-team-view]').forEach(b=>b.onclick=()=>{teamView=b.dataset.teamView;rememberView();setTeamTabs();$('#team-search').placeholder=teamView==='questions'?'Search questions and answers…':teamView==='activity'?'Search activity…':'Search team context…';renderTeam();});
$('#team-project').onchange=()=>{teamProject=$('#team-project').value;rememberView();renderTeam();};
$('#team-search').oninput=renderTeam;
$('#settings').onclick=()=>{
  openDetail('<h2>Workspace settings</h2><p>'+ (state.member?'Signed in as <strong>'+esc(state.member)+'</strong>.':'Workspace connection saved. Currently unable to verify your sign-in.')+'</p>'+
    '<p>Relay '+esc(state.release?.version||'unknown')+' · '+(state.supervised?'Background recovery on':'Background recovery not detected')+'</p>'+
    '<p>Start quietly when you sign in to this computer. Saved sharing choices are preserved; paused conversations stay paused.</p><button id="startup-toggle">'+(state.startup_enabled?'Turn off login startup':'Start Relay when I sign in')+'</button>'+
    '<p class="small">Quit Relay stops this app for now. Login startup runs again at your next sign-in. The shared hub is separate and its host must stay awake.</p>'+
    '<details><summary>Advanced connection details</summary><p>'+esc(state.workspace)+'</p><p>Build '+esc(state.release?.build?.slice(0,12)||'unknown')+'. Keep the workspace host running. Remote teammates also need their private network connection.</p></details>'+
    '<div class="actions"><button id="change-workspace">Change workspace</button><a href="'+esc(state.workspace)+'" target="_blank" rel="noopener">Manage invites and ownership ↗</a></div>');
  $('#change-workspace').onclick=()=>{joining=true;view='agent';$('#detail').close();layout();$('#url').focus();};
  $('#startup-toggle').onclick=()=>busy($('#startup-toggle'),async()=>{
    const enabled=!state.startup_enabled;
    if(!confirm(enabled?'Allow Relay to start quietly at login and resume only your previously approved sharing?':'Turn off automatic login startup? Relay will keep running until you quit.'))return;
    await api('startup',{enabled,consent:true});await refresh();$('#settings').click();
  });
};
$('#team-check').onclick=()=>busy($('#team-check'),async()=>{
  const result=await api('team-check',{project_id:teamProject||$('#team-project').value});
  openDetail('<h2>'+ (result.ready?'Both developers are connected':'Team connection check')+'</h2>'+
    '<p>Required release: Relay '+esc(result.release.version)+' ('+esc(result.release.build.slice(0,12))+'). No model calls were made.</p>'+
    (!result.hub_matches?'<p class="warning">The workspace host needs the same Relay release.</p>':'')+
    (result.participants.length?result.participants.map(p=>'<section class="card"><h3>'+esc(p.owner)+' · '+esc(p.name)+'</h3><p>Sharing app '+esc(p.worker_version)+' · Agent connector '+esc(p.agent_version)+'</p>'+
      (p.problems.length?'<ul>'+p.problems.map(v=>'<li>'+esc(v)+'</li>').join('')+'</ul>':'<p>Connection checks passed.</p>')+'</section>').join(''):'<p>Connect one conversation on each developer’s computer to begin.</p>')+
    '<p class="small">'+esc(result.scope)+'</p><p>Next: on the same project, ask about a decision from your teammate’s feature. Check the answer and its evidence, then repeat in the opposite direction.</p>'+
    '<details><summary>Updating a Mac installation</summary><p>Run this once in Terminal, then quit and reopen Relay and reconnect its tools in the coding client. Your saved sharing choices stay in place.</p><pre>brew update &amp;&amp; brew upgrade relay/workspace/relay-workspace</pre></details>');
});
$('#cancel-join').onclick=()=>{joining=false;clearInterval(pairTimer);$('#pairing').textContent='';layout();};
$('#cancel-connection').onclick=()=>{adding=false;invalidateSelection();error('');layout();};
$('#back-folder').onclick=()=>{invalidateSelection();layout();$('#repo').focus();};
$('#retry-network').onclick=()=>busy($('#retry-network'),async()=>{await refresh();});
$('#join').onsubmit=event=>{event.preventDefault();busy($('#join button'),async()=>{
  clearInterval(pairTimer);const pair=await api('pair',{url:$('#url').value});
  $('#pairing').innerHTML='Approve this computer in the workspace tab. Match code <strong>'+esc(pair.code)+'</strong>.<br><a href="'+esc(pair.url)+'" target="_blank" rel="noopener">Open approval page ↗</a>';
  let polling=false;
  pairTimer=setInterval(async()=>{
    if(polling)return;polling=true;
    try{const result=await api('poll',{});if(result.status==='approved'){clearInterval(pairTimer);connected=false;repositoriesLoaded=false;joining=false;teamState=null;teamSignature='';$('#team-body').innerHTML='';$('#pairing').textContent='';await refresh();}}
    catch(e){clearInterval(pairTimer);error(e.message);}finally{polling=false;}
  },2000);
});};
$('#browse').onclick=()=>busy($('#browse'),async()=>{const r=await api('choose-folder',{});if(r.path){$('#repo').value=r.path;invalidateSelection();}});
function invalidateSelection(){choosingConversation=false;$('#session-area').hidden=true;$('#select-form').hidden=false;$('#consent').checked=false;}
for(const id of ['repo','provider'])$('#'+id).oninput=invalidateSelection;
$('#select-form').onsubmit=event=>{event.preventDefault();busy($('#select-form button[type=submit]'),async()=>{
  const provider=$('#provider').value,repo=$('#repo').value;
  const found=await api('sessions',{provider,repo});
  if(provider!==$('#provider').value||repo!==$('#repo').value)return;
  sessions=found;$('#consent').checked=false;
  if(!sessions.length)throw Error('No conversations found here. Start a conversation in this repository in your coding agent, then try again.');
  choosingConversation=true;$('#session-search').value='';
  $('#selected-repository').textContent=(provider==='claude'?'Claude Code':'Codex')+' · '+repo;
  $('#session-search').hidden=sessions.length<5;$('label[for="session-search"]').hidden=sessions.length<5;
  filterSessions();layout();$('#session').focus();
});};
function filterSessions(){
  const query=$('#session-search').value.toLowerCase();
  const rows=sessions.filter(s=>s.name.toLowerCase().includes(query));
  $('#session').innerHTML=rows.map(s=>'<option value="'+esc(s.id)+'" '+(s.compatible?'':'disabled')+'>'+esc(s.name)+(s.updated?' · '+new Date(s.updated*1000).toLocaleString():'')+(s.compatible?'':' · different checkout')+'</option>').join('');
  $('#session').value=rows.find(s=>s.compatible)?.id||'';$('#consent').checked=false;sessionHint();
  if(!rows.length)$('#session-hint').textContent='No matching conversations. Clear the search or try another title.';
}
$('#session-search').oninput=filterSessions;
function sessionHint(){const s=sessions.find(s=>s.id===$('#session').value);$('#session-hint').textContent=s?'Only this selected conversation will be connected.':'These conversations belong to another checkout. Choose their original repository.';$('#connect').disabled=!s;}
$('#session').onchange=()=>{$('#consent').checked=false;sessionHint();};
$('#connect').onclick=()=>busy($('#connect'),async()=>{
  if(!$('#consent').checked)throw Error('Select the sharing checkbox before connecting.');
  await api('connect',{project:$('#project').value,source_id:$('#session').value,name:$('#feature').value,consent:true});
  invalidateSelection();adding=false;$('#feature').value='';await refresh();notice('Conversation connected. Next, enable agent tools so your coding agent can work with the team.');
  $('#connections').scrollIntoView({behavior:'smooth'});
});
$('#quit').onclick=()=>busy($('#quit'),async()=>{
  if(!confirm('Stop Relay on this computer? Syncing will stop. Open Relay again to reconnect.'))return;
  await api('quit',{});stopped=true;clearInterval(pairTimer);
  document.querySelector('main').innerHTML='<section class="intro"><h1>Relay is stopped.</h1><p>You can close this tab. Open the Relay app to reconnect.</p></section>';
});
setTeamTabs();
refresh().catch(e=>error(e.message));
setInterval(()=>refresh().catch(e=>{$('#network-status').hidden=false;$('#network-message').textContent=e.message;}),8000);
