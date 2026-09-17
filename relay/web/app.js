const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const initials = name => esc((name || '?').split(' ').map(s => s[0]).join('').slice(0,2).toUpperCase());
const ago = timestamp => {
  if (!timestamp) return 'not connected';
  const minutes = Math.max(0, Math.floor((Date.now()/1000-timestamp)/60));
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes/60)}h ago` : `${Math.floor(minutes/1440)}d ago`;
};
let state, projectId = localStorage.getItem('relay-project'), view = 'context', search = '';
let refreshing = null, stream = null, toastTimer, activityFilter = 'all';
const modal = $('#modal');
async function api(path, data) {
  const response = await fetch('/api/' + path, {method: data === undefined ? 'GET' : 'POST', headers: {'Content-Type':'application/json','X-Relay-Client':'web'}, ...(data === undefined ? {} : {body:JSON.stringify(data)})});
  const body = await response.json();
  if (!response.ok) {const error=new Error(body.error || 'Request failed'); error.status=response.status; throw error;}
  return body;
}
const action = (name, data) => api('actions/' + name, data);
const project = () => state?.projects.find(p => p.id === projectId);
const scoped = key => (state?.[key] || []).filter(item => item.project_id === projectId);
const bindingFor = id => state?.bindings.find(b => b.session_id === id);
const providerName = provider => provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude Code' : 'Manual';
const ready = binding => binding?.enabled && binding.worker_online && !['error','offline','budget-limited'].includes(binding.status);
function toast(message) {$('#toast').textContent=message; $('#toast').hidden=false; clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,4500);}
function open(content) {$('#modal-content').innerHTML=content; if(!modal.open) modal.showModal(); modal.scrollTop=0;}
function errorText(error) {const element=$('.error',modal); if(element) element.textContent=error.message; else toast(error.message);}
function formSubmit(callback) {
  const form=$('form',modal);
  form.onsubmit=async event=>{event.preventDefault(); const button=$('button[type=submit]',form); button.disabled=true;try {await callback(Object.fromEntries(new FormData(form)));} catch(error){errorText(error);} finally{button.disabled=false;}};
}
$('#close-modal').onclick=()=>modal.close();
function connectStream() {
  if(stream) stream.close();stream=new EventSource('/api/stream');
  stream.addEventListener('changed',()=>refresh());
  stream.onopen=()=>{$('#connection').textContent='● Live sync';$('#connection').className='connection';};
  stream.onerror=()=>{$('#connection').textContent='● Reconnecting';$('#connection').className='connection offline';};
}
async function refresh(force=false) {
  if(refreshing){await refreshing;if(force)return refresh(true);return;}
  refreshing=(async()=>{try {
    const next=await api('state');const replacer=(key,value)=>key==='server_time'?undefined:value;
    const changed=JSON.stringify(next,replacer)!==JSON.stringify(state,replacer);state=next;
    if(!state.projects.some(p=>p.id===projectId)) projectId=state.projects[0]?.id;
    if(force||changed)render();
  } catch(error) {$('#connection').textContent='● Workspace offline';$('#connection').className='connection offline';if(error.status===401){if(stream)stream.close();if(!modal.open)login();}}})();
  try{await refreshing;}finally{refreshing=null;}
}
function render() {
  const searchFocused=document.activeElement?.id==='search';
  const expandedLogs=[...document.querySelectorAll('.log-row[open]')].map(row=>row.dataset.event);
  const features=scoped('features'), bindings=scoped('bindings'), questions=scoped('questions');
  $('#project-name').textContent=project()?.name||'Getting started';$('#my-name').textContent=state.me.name;$('#my-avatar').innerHTML=initials(state.me.name);
  $('#feature-count').textContent=features.length;$('#session-count').textContent=bindings.length;$('#question-count').textContent=questions.filter(q=>!q.answer).length;
  $('#project-list').innerHTML=state.projects.map(p=>`<button class="project-button ${p.id===projectId?'active':''}" data-project="${p.id}"><span>⌁</span>${esc(p.name)}</button>`).join('');
  document.querySelectorAll('[data-project]').forEach(button=>button.onclick=()=>{projectId=button.dataset.project;localStorage.setItem('relay-project',projectId);search='';render();});
  document.querySelectorAll('[data-view]').forEach(button=>button.classList.toggle('active',button.dataset.view===view));
  const titles={context:['Your team’s shared context','Decisions and explanations from your connected coding agents.'],activity:['Activity','See what your connected agents have been working on.'],inbox:['Questions & answers','Ask about a feature. The agent that worked on it answers here.'],sessions:['Your team’s agents','See which agents are connected, or pause sharing.']};
  $('#page-title').textContent=titles[view][0];$('#page-description').textContent=titles[view][1];$('#publish').textContent=project()?'Connect an agent':'Create project';
  $('#publish').hidden=view==='context'&&!bindings.length;
  $('#stats').hidden=!bindings.length;
  $('#stats').innerHTML=`<div class="stat"><span class="stat-value">${String(features.length).padStart(2,'0')}</span><div class="stat-label">Features understood<small>${features.filter(f=>f.checkpoint.origin==='agent-derived').length} automatically maintained</small></div></div><div class="stat"><span class="stat-value">${String(bindings.filter(ready).length).padStart(2,'0')}</span><div class="stat-label">Live responders<small>${bindings.length} source sessions connected</small></div></div><div class="stat"><span class="stat-value">${String(questions.filter(q=>q.answer).length).padStart(2,'0')}</span><div class="stat-label">Gaps clarified<small>${questions.filter(q=>!q.answer).length} conversations still open</small></div></div>`;
  if(!project())return renderWelcome();
  if(view==='context')renderContext();else if(view==='activity')renderActivity();else if(view==='sessions')renderSessions();else renderConversations();
  document.querySelectorAll('.log-row').forEach(row=>{row.open=expandedLogs.includes(row.dataset.event);});
  if(searchFocused&&$('#search'))$('#search').focus();
}
function renderWelcome() {
  $('#workspace-body').innerHTML='<div class="start-card"><span class="eyebrow">FIRST STEP</span><h2>Create a project for you and your team.</h2><p>Then connect a Codex or Claude Code conversation. Relay will share its activity and keep the context up to date.</p><button class="primary" id="first-project">Create project</button></div>';
  $('#first-project').onclick=createProject;
}
function featureCard(feature) {
  const cp=feature.checkpoint,binding=bindingFor(feature.session_id);
  const label=cp.origin==='pending'?'AWAITING CONTEXT':cp.origin==='agent-derived'?'AUTO UPDATED':'PRESERVED NOTE';
  return `<button class="feature-card" data-feature="${feature.id}"><div class="card-top"><span class="feature-glyph">${binding?.provider==='claude'?'✳':'⌘'}</span><span class="tag">${label} · v${feature.version}</span></div><h3>${esc(feature.title)}</h3><p class="summary">${esc(cp.summary)}</p><div class="card-meta"><span>${providerName(binding?.provider)}</span><span>${esc(cp.branch||'branch unknown')} · ${esc(cp.commit_sha?.slice(0,7)||'revision unknown')}</span></div><div class="card-footer"><span class="avatar">${initials(feature.owner)}</span><span>${esc(feature.owner)}</span><span class="presence ${ready(binding)?'online':''}"></span><time>${ago(feature.updated)}</time></div></button>`;
}
function wireFeatures(root=document){root.querySelectorAll('[data-feature]').forEach(button=>button.onclick=()=>showFeature(button.dataset.feature));}
function eventHtml(item) {return `<div class="event"><span class="event-icon">${item.kind==='answer'?'↔':item.kind==='context'?'◈':'·'}</span><div class="event-line">${esc(item.label)}<small>${esc(item.author)} · ${ago(item.created)}</small></div></div>`;}
function renderContext() {
  const bindings=scoped('bindings');
  if(!bindings.length){
    $('#workspace-body').innerHTML=`<div class="start-card"><span class="eyebrow">LET’S CONNECT YOUR FIRST AGENT</span><h2>Keep coding. Let the context follow.</h2><p>Pick a conversation from Codex or Claude Code. Its activity and explanations will appear here automatically.</p><button class="primary" id="first-agent">Connect an agent</button><p class="helper">One guided setup on your computer. No handoff documents.</p></div>${scoped('features').length?`<details class="history-item"><summary>Previously saved notes (${scoped('features').length})</summary><div class="cards">${scoped('features').map(featureCard).join('')}</div></details>`:''}`;
    $('#first-agent').onclick=setup;wireFeatures();return;
  }
  $('#workspace-body').innerHTML=`<div class="toolbar"><div class="section-label">Living feature context <small>Source-linked, versioned, automatically maintained</small></div><label class="search" aria-label="Search shared context"><input id="search" type="search" value="${esc(search)}" placeholder="Find a feature, decision, or constraint…"></label></div><div class="board"><div class="cards" id="cards"></div><aside class="rail"><section class="rail-section"><h3>Connected sources <span class="muted">/ ${bindings.length}</span></h3>${bindings.map(binding=>{const session=state.sessions.find(s=>s.id===binding.session_id);return `<div class="person"><span class="avatar">${initials(session?.owner)}</span><div class="person-text"><strong>${esc(session?.name)}</strong><small>${providerName(binding.provider)} · ${!binding.enabled?'paused':binding.worker_online?binding.status:'offline'}</small></div><span class="presence ${ready(binding)?'online':''}"></span></div>`;}).join('')||'<p class="muted">Connect a source session to begin automatic updates.</p>'}<button class="link-btn" id="rail-connect">Connect a session ↗</button></section><section class="rail-section"><h3>Knowledge moving</h3>${scoped('events').slice(0,5).map(eventHtml).join('')}</section><div class="rail-note"><strong>The next question has a destination.</strong><p>Your agent can ask the session that built a feature. Its response returns with source references and becomes part of the shared context.</p></div></aside></div>`;
  function filter(){const terms=search.toLowerCase().split(/\s+/).filter(Boolean);const features=scoped('features').filter(feature=>terms.every(term=>(feature.title+' '+JSON.stringify(feature.checkpoint)).toLowerCase().includes(term)));
    $('#cards').innerHTML=features.map(featureCard).join('')||(search?'<div class="empty"><p>No matching context yet. Try a feature name or an implementation detail.</p></div>':'<div class="empty"><div class="big-glyph">↔</div><h2>Connect the session behind the feature.</h2><p>Relay will observe its activity and maintain the shared context automatically. No handoff document to fill in.</p><button class="primary" id="empty-connect">Connect Codex or Claude Code →</button></div>');
    wireFeatures($('#cards'));if($('#empty-connect'))$('#empty-connect').onclick=setup;}
  $('#search').oninput=event=>{search=event.target.value;filter();};$('#rail-connect').onclick=setup;filter();
}
function renderActivity() {
  const observations=scoped('observations').filter(item=>activityFilter==='all'||item.kind===activityFilter);
  $('#workspace-body').innerHTML=`<div class="toolbar"><div class="section-label"><span class="tiny-dot"></span> Live activity <small>Most recent 250 captured events</small></div><select id="activity-filter" aria-label="Filter activity">${['all','user','assistant','tool','file','turn'].map(kind=>`<option value="${kind}" ${activityFilter===kind?'selected':''}>${kind==='all'?'All events':kind}</option>`).join('')}</select></div><div class="live-log">${observations.map(item=>`<details class="log-row"><summary><span class="log-kind ${item.kind}">${item.kind}</span><span class="log-content"><strong>${esc(item.body.split('\n')[0])}</strong><small>${providerName(item.provider)} / ${esc(item.session_name)} · ${esc(item.author)}</small></span><time>${ago(item.created)}</time></summary><div class="log-detail"><pre>${esc(item.body)}</pre><div class="helper">Source: ${esc(item.source_ref)}<br>Checkout observed: ${esc(item.revision||'unknown')} · received ${new Date(item.created*1000).toLocaleString()}</div></div></details>`).join('')||'<div class="empty"><div class="big-glyph">≋</div><h2>Activity arrives from your sessions.</h2><p>Run the local connector for a selected session. User messages, visible agent responses, tool activity, file changes, and completed turns will appear here.</p><button class="primary" id="activity-connect">Connect a working session →</button></div>'}</div><div class="section-gap"><h3 class="mini-heading">Workspace history</h3><div class="list-card">${scoped('events').slice(0,15).map(eventHtml).join('')}</div></div>`;
  document.querySelectorAll('.log-row').forEach((row,index)=>{row.dataset.event=String(observations[index].id);});
  $('#activity-filter').onchange=event=>{activityFilter=event.target.value;renderActivity();};if($('#activity-connect'))$('#activity-connect').onclick=setup;
}
function statusLabel(question) {
  if(question.answer)return 'ANSWERED';const binding=bindingFor(question.recipient_id),job=question.job;
  if(!job)return 'MANUAL SESSION';if(job.status==='failed')return 'NEEDS ATTENTION';if(!binding?.enabled)return 'PAUSED';if(!binding.worker_online)return 'WAITING FOR PC';return job.status==='running'?'AGENT ANSWERING':'QUEUED';
}
function renderConversations() {
  $('#workspace-body').innerHTML=`<div class="toolbar"><span class="section-label">Clarification conversations <small>Questions → source sessions → shared answers</small></span></div>${scoped('questions').map(question=>`<article class="list-card conversation"><div class="row"><span class="muted">${esc(question.author)} <span class="route-arrow">→</span> ${esc(question.recipient_name)}</span><span class="tag ${question.job?.status==='failed'?'error-tag':''}">${statusLabel(question)}</span></div><p class="question-body">${esc(question.body)}</p><button class="link-btn" data-feature="${question.feature_id}">${esc(state.features.find(f=>f.id===question.feature_id)?.title||'View feature')} ↗</button>${question.answer?`<div class="answer-block"><span class="eyebrow">${question.job?.response_session?'SOURCE SESSION FORK':'DEVELOPER RESPONSE'}</span><p>${esc(question.answer)}</p>${question.evidence?`<pre class="code">${esc(question.evidence)}</pre>`:''}${question.job?.source_ref?`<div class="helper">Source: ${esc(question.job.source_ref)}<br>Response session: ${esc(question.job.response_session)}</div>`:''}</div>`:`<p class="helper">${question.job?'The owning PC’s responder processes this automatically when it is available.':'This older session has no live responder. Its developer can answer below.'}</p>${question.job?.error?`<p class="warning">${esc(question.job.error)}</p>`:''}${question.recipient_member_id===state.me.id?`<div class="actions">${question.job?.status==='failed'?`<button class="secondary" data-retry="${question.id}">Retry clarification</button>`:''}<button class="text-btn" data-answer="${question.id}">Answer yourself</button></div>`:''}`}</article>`).join('')||'<div class="empty"><div class="big-glyph">↔</div><h2>Let the agents fill in the gaps.</h2><p>When your agent calls relay_clarify, the question travels to the feature’s source session. You can follow the exchange here or ask a question from any feature.</p></div>'}`;
  wireFeatures();document.querySelectorAll('[data-answer]').forEach(button=>button.onclick=()=>answerForm(button.dataset.answer));
  document.querySelectorAll('[data-retry]').forEach(button=>button.onclick=async()=>{const q=state.questions.find(q=>q.id===button.dataset.retry);try{await action('job-retry',{session_id:q.recipient_id,question_id:q.id});await refresh(true);}catch(error){toast(error.message);}});
}
function renderSessions() {
  const sessions=scoped('sessions').filter(session=>bindingFor(session.id));
  const labels={watching:'Syncing',summarizing:'Updating context',answering:'Answering a question',error:'Needs attention','budget-limited':'Hourly limit reached',connecting:'Starting',offline:'Offline'};
  $('#workspace-body').innerHTML=sessions.map(session=>{
    const binding=bindingFor(session.id);
    const status=!binding.enabled?'Paused':!binding.worker_online?'Offline':labels[binding.status]||'Starting';
    const hint=!binding.enabled?'Sharing is paused. Resume when you’re ready.':!binding.worker_online?'Restart the saved connection on this agent’s computer.':binding.status==='budget-limited'?'New explanations will wait until an hourly usage slot is available. Activity keeps syncing.':'Leave the local connector running while you code.';
    return `<article class="list-card"><div class="row"><h3>${providerName(binding.provider)} / ${esc(session.name)}</h3><span class="tag">${status}</span></div><p>${esc(session.owner)} · ${esc(session.machine||'machine not recorded')}</p><p>${hint}</p>${binding.error?`<p class="warning">${esc(binding.error)}</p>`:''}<details class="history-item"><summary>Connection details</summary><p class="helper">Source conversation: ${esc(binding.source_id)}<br>${binding.worker_seen?'Last seen '+ago(binding.worker_seen):binding.status==='offline'?'Stopped '+ago(binding.updated):'No worker heartbeat recorded yet.'}</p></details>${session.member_id===state.me.id?`<div class="actions"><button class="secondary" data-toggle="${session.id}">${binding.enabled?'Pause sharing':'Resume sharing'}</button></div>`:''}</article>`;
  }).join('')||'<div class="empty"><h2>No agents connected yet.</h2><p>Connect an agent using the button above. Previously saved notes don’t count as a live connection.</p></div>';
  document.querySelectorAll('[data-toggle]').forEach(button=>button.onclick=async()=>{try{const binding=bindingFor(button.dataset.toggle);await action('session-toggle',{session_id:binding.session_id,enabled:!binding.enabled});await refresh(true);}catch(error){toast(error.message);}});
}
const contextSections=[['summary','Implementation'],['decisions','Decisions & rationale'],['constraints','Constraints'],['rejected','Rejected approaches'],['assumptions','Unverified assumptions'],['tests','Verification'],['questions','Open questions'],['evidence','Evidence & references']];
function showFeature(id) {
  const feature=state.features.find(f=>f.id===id);if(!feature)return;const cp=feature.checkpoint,binding=bindingFor(feature.session_id);
  open(`<h2>${esc(feature.title)}</h2><div class="detail-head"><span class="avatar">${initials(feature.owner)}</span><span>${esc(feature.owner)} / ${providerName(binding?.provider)}</span><span class="tag">v${feature.version}</span><span>${ago(feature.updated)}</span></div><div class="notice">${cp.origin==='agent-derived'?'Automatically maintained from the source session. Agent-derived claims retain their uncertainty.':cp.origin==='pending'?'The source session is connected. Its first completed turn will produce context.':'A preserved manual checkpoint from the previous workflow.'}</div>${cp.source_cursor?`<p class="helper">Source ${esc(cp.source_id)} · context cursor ${esc(cp.source_cursor)}</p>`:''}<p class="helper">${esc(cp.branch||'branch unknown')} / ${esc(cp.commit_sha||'revision unknown')}${cp.dirty?' · uncommitted changes':''}${cp.revision_basis?'<br>'+esc(cp.revision_basis):''}</p>${contextSections.filter(([key])=>cp[key]).map(([key,label])=>`<section class="detail-section"><h3>${label}</h3>${key==='evidence'?`<pre>${esc(cp[key])}</pre>`:`<p>${esc(cp[key])}</p>`}</section>`).join('')}<div class="actions"><button class="secondary" id="history">Version history</button>${feature.member_id===state.me.id?'<button class="text-btn" id="transfer">Transfer ownership</button>':''}<button class="primary" id="ask-owner">Ask ${binding?providerName(binding.provider):'the owner'} ↗</button></div>`);
  $('#ask-owner').onclick=()=>askForm(feature);$('#history').onclick=()=>featureHistory(feature);if($('#transfer'))$('#transfer').onclick=()=>transfer(feature);
}
function askForm(feature) {
  const binding=bindingFor(feature.session_id);
  open(`<h2>Ask the session that knows.</h2><p>About ${esc(feature.title)}. ${binding?'The local responder will answer from a separate fork of the source session.':'This manual session needs an answer from its developer.'}</p><form><label>What needs clarification?<textarea name="body" required maxlength="6000" placeholder="Why was this approach chosen? What should I know before changing it?"></textarea></label><div class="error" role="alert"></div><div class="actions"><button class="primary" type="submit">Ask ${binding?providerName(binding.provider):'the owner'} →</button></div></form>`);
  formSubmit(async data=>{await action('question',{...data,feature_id:feature.id});modal.close();view='inbox';await refresh(true);toast('Clarification routed to the source session.');});
}
function answerForm(id) {
  const question=state.questions.find(q=>q.id===id);open(`<h2>Add your explanation.</h2><p>${esc(question.body)}</p><form><label>Answer<textarea name="answer" required maxlength="12000"></textarea></label><label>References<textarea name="evidence" maxlength="12000"></textarea></label><div class="error"></div><div class="actions"><button class="primary" type="submit">Share answer →</button></div></form>`);
  formSubmit(async data=>{await action('answer',{...data,question_id:id});modal.close();await refresh(true);});
}
async function featureHistory(feature) {
  try{const versions=await api('history/'+feature.id);open(`<h2>${esc(feature.title)} / history</h2><p>The understanding evolves. Earlier records stay available.</p>${versions.map(version=>`<details class="history-item"><summary>v${version.version} · ${version.checkpoint.origin==='agent-derived'?'automatic':'manual'} · ${esc(version.checkpoint.author)} · ${ago(version.created)}</summary>${contextSections.filter(([key])=>version.checkpoint[key]).map(([key,label])=>`<h3 class="mini-heading">${label}</h3><p>${esc(version.checkpoint[key])}</p>`).join('')}</details>`).join('')}`);}catch(error){errorText(error);}
}
function transfer(feature) {
  const targets=scoped('sessions').filter(s=>s.id!==feature.session_id);if(!targets.length)return toast('Connect another session in this project first.');
  open(`<h2>Hand over this feature.</h2><p>History retains its authors. Automatic updates from the previous source will stop. New questions go to the new owner; existing conversations stay with their original recipient.</p><form><label>New owning session<select name="session_id">${targets.map(s=>`<option value="${s.id}">${esc(s.owner)} / ${esc(s.name)}</option>`).join('')}</select></label><div class="error"></div><div class="actions"><button class="primary" type="submit">Transfer ownership →</button></div></form>`);
  formSubmit(async data=>{await action('transfer',{...data,feature_id:feature.id});await refresh(true);showFeature(feature.id);});
}
function createProject() {
  open('<h2>Create your project</h2><p>A shared space for your team’s coding context.</p><form><label for="project-input">Project name</label><input id="project-input" name="name" required maxlength="120" placeholder="e.g. Atlas API"><details class="history-item"><summary>Add a description or repository (optional)</summary><label>Repository URL or label<input name="repository" maxlength="500"></label><label>Description<textarea name="description" maxlength="2000"></textarea></label></details><div class="error" role="alert"></div><div class="actions"><button class="primary" type="submit">Create project</button></div></form>');
  formSubmit(async data=>{const result=await action('project',data);projectId=result.id;localStorage.setItem('relay-project',projectId);await refresh(true);setup();});
}
function setup() {
  if(!project())return createProject();
  const hub=state.workspace_url||location.origin;
  const brew=`brew tap relay/workspace ${hub}/homebrew/tap.git && brew install relay/workspace/relay-workspace`;
  const python=`python -c "import urllib.request;exec(urllib.request.urlopen('${hub}/install.py').read())"`;
  open(`<h2>Connect your agent from the Relay app</h2><p>This page is your shared workspace. Your local Relay app connects the conversation on your own computer.</p><ol><li>Open <strong>Relay.app</strong> on Mac, or the Relay launcher saved by your installer on Windows/Linux.</li><li>Choose your project folder and conversation, then approve sharing.</li><li>In <strong>My agent</strong>, click <strong>Enable agent tools</strong> and approve. Reconnect your coding client to load them.</li></ol><button class="secondary" id="copy-workspace">Copy workspace address</button><p class="helper">Already installed? No reinstall or access token is needed for the normal saved-sign-in flow. If Enable agent tools is missing, your Relay client needs an update.</p><details class="history-item"><summary>I need to install Relay</summary><label for="install-platform">Computer</label><select id="install-platform"><option value="mac">macOS / Homebrew</option><option value="windows">Windows / Python</option><option value="linux">Linux / Python</option></select><pre class="code" id="start-command"></pre><button class="secondary" id="copy-start">Copy install command</button><p class="helper" id="install-hint"></p><p><a href="/install.py" target="_blank" rel="noopener">Review Python installer</a> · <a href="/client.zip">Download source ZIP</a></p></details><p class="helper">Keep the workspace host and private network connection running. Sharing a conversation does not automatically enable agent tools or enforce conflict prevention.</p>`);
  $('#install-platform').value=/Mac/i.test(navigator.platform)?'mac':/Win/i.test(navigator.platform)?'windows':'linux';
  function installation(){const os=$('#install-platform').value;return os==='mac'?brew:os==='linux'?python.replace(/^python /,'python3 '):python;}
  function showInstallation(){$('#start-command').textContent=installation();$('#install-hint').textContent=$('#install-platform').value==='mac'?'Run once in Terminal. Open Relay.app from the location Homebrew prints, then keep it in your Dock. Homebrew is required.':'Requires Python 3.11+, Git, and your coding agent installed and signed in. Run once; the installer opens Relay and prints a launcher for next time.';}
  $('#install-platform').onchange=showInstallation;showInstallation();
  $('#copy-start').onclick=()=>navigator.clipboard.writeText(installation()).then(()=>toast('Single-line command copied')).catch(()=>toast('Select and copy the command above.'));
  $('#copy-workspace').onclick=()=>navigator.clipboard.writeText(hub).then(()=>toast('Workspace address copied')).catch(()=>toast(hub));
}
function help() {
  open('<h2>One workspace. Your own computer.</h2><div class="help-row"><h3>Daily work</h3><p>Open the Relay app. My agent controls sharing and agent access. Team workspace shows shared context, questions and activity.</p></div><div class="help-row"><h3>Sharing or agent access?</h3><p>Sharing keeps the dashboard up to date. Enable agent tools lets your coding client search context, ask teammates and exchange work plans. Reconnect the coding client after enabling.</p></div><div class="help-row"><h3>Connection trouble</h3><p>Keep the workspace host and your private network connection running. Retry in the Relay app. Your saved setup stays in place; a temporary outage does not require reinstalling.</p></div><p class="notice">Coordination is advisory. Agent tools do not enforce edits, wake idle coding agents, or merge branches.</p><div class="actions"><button class="primary" id="help-connect">Connect an agent</button></div>');
  $('#help-connect').onclick=setup;
}
function invite() {
  if(state.me.role!=='owner')return toast('Ask the workspace owner to invite your teammate.');
  open(`<h2>Invite your teammate</h2><p>Send one private link. They join in their browser—no token to copy.</p><form><label>Developer name<input name="name" required maxlength="80"></label><div class="error"></div><div class="actions"><button class="primary" type="submit">Create invite link</button></div></form><h3 class="mini-heading">Members</h3>${state.members.filter(m=>m.role!=='owner').map(member=>`<div class="member-row"><span>${esc(member.name)} ${member.revoked?'· revoked':''}</span>${member.revoked?'':`<button class="text-btn" data-revoke="${member.id}">Revoke access</button>`}</div>`).join('')}`);
  formSubmit(async data=>{const result=await action('invite-link',data);open(`<h2>${esc(data.name)} can join</h2><p>Share this link privately. It works once and expires in 24 hours. Anyone holding it can join as this teammate.</p><pre class="code token-output">${esc(result.url)}</pre><button class="primary" id="copy-invite">Copy invite link</button><p class="helper">They still need access to the private Tailscale network. Existing teammates can keep their current sign-in.</p>`);$('#copy-invite').onclick=()=>navigator.clipboard.writeText(result.url).then(()=>toast('Invite link copied')).catch(()=>toast('Select and copy the link above.'));});
  document.querySelectorAll('[data-revoke]').forEach(button=>button.onclick=async()=>{try{await action('revoke',{member_id:button.dataset.revoke});await refresh(true);invite();}catch(error){errorText(error);}});
}
function profile() {
  open(`<h2>Your workspace identity.</h2><form><label>Display name<input name="name" required maxlength="80" value="${esc(state.me.name)}"></label><div class="error"></div><div class="actions"><button class="secondary" type="button" id="switch-user">Switch developer</button><button class="primary" type="submit">Save name</button></div></form>`);
  formSubmit(async data=>{await action('profile',data);modal.close();await refresh(true);});$('#switch-user').onclick=async()=>{await api('logout',{});if(stream)stream.close();login();};
}
const joinFragment=new URLSearchParams(location.hash.slice(1));
let inviteSecret=joinFragment.get('invite'), pairingCode=joinFragment.get('pair');
if(inviteSecret||pairingCode)window.history.replaceState(null,'',location.pathname);
async function afterLogin(){
  modal.close();await refresh(true);connectStream();
  if(pairingCode)await approveComputer();
}
async function approveComputer(){
  try {
    const request=await api('pair/preview',{code:pairingCode});
    open(`<h2>Connect this computer?</h2><p>Approve <strong>${esc(request.machine)}</strong> as ${esc(state.me.name)}.</p><pre class="code">${esc(request.code)}</pre><p>Only approve if you just opened Relay on this computer and the code matches. This gives the app your workspace access. No conversations are shared until you choose one in the app.</p><form><div class="error"></div><div class="actions"><button class="primary" type="submit">Approve this computer</button></div></form>`);
    formSubmit(async()=>{await api('pair/approve',{code:pairingCode});pairingCode=null;open('<h2>Computer connected</h2><p>Return to the <strong>Relay · This computer</strong> tab to choose your conversation. You can close this tab.</p>');});
  }catch(error){open(`<h2>Connection needs another try</h2><p>${esc(error.message)}</p>`);}
}
function login() {
  open('<h2>Join your workspace</h2><p>Open the invite link your workspace owner sent you to join without a token.</p><details class="history-item"><summary>I already have an access token</summary><form><label>Access token<input name="token" type="password" required autocomplete="off"></label><div class="error"></div><div class="actions"><button class="primary" type="submit">Sign in</button></div></form></details>');
  formSubmit(async data=>{await api('login',data);await afterLogin();});
}
async function joinInvite(){
  try {
    const preview=await api('invitation',{secret:inviteSecret});
    open(`<h2>Welcome, ${esc(preview.name)}</h2><p>Join this workspace to share coding context with your team. No local conversations are connected or uploaded by joining.</p><form><div class="error"></div><div class="actions"><button class="primary" type="submit">Join workspace</button></div></form>`);
    formSubmit(async()=>{await api('join',{secret:inviteSecret});inviteSecret=null;await afterLogin();});
  }catch(error){open(`<h2>Invite unavailable</h2><p>${esc(error.message)}</p>`);}
}
document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>{if(!state)return;view=button.dataset.view;render();});
$('#add-project').onclick=createProject;$('#publish').onclick=setup;$('#setup').onclick=help;$('#invite').onclick=()=>state&&invite();$('#profile').onclick=()=>state&&profile();
(async()=>{if(inviteSecret)return joinInvite();try{await api('state');}catch(error){if(error.status===401){try{await api('local-session',{});}catch{login();return;}}else throw error;}await afterLogin();})().catch(error=>toast(error.message));
setInterval(()=>{if(state)refresh();},20000);
