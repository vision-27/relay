/** No shell, runtime download, transcript, prompt, or tool-result upload. */
export function codexRemoteHooks(server='relay_remote'){
  const events=['UserPromptSubmit','Stop'] as const;
  return {description:'Relay inbox checks at Codex turn boundaries',hooks:Object.fromEntries(events.map(event=>[event,[{hooks:[{
    type:'mcp_tool',server,tool:'relay_hook',timeout:8,statusMessage:'Checking Relay inbox',
    input:{native_session_id:'${session_id}',hook_event_name:event,...(event==='Stop'?{stop_hook_active:'${stop_hook_active}'}:{})}
  }]}]]))};
}

/** Preserve all unrelated hooks and make repeat installation idempotent. */
export function mergeCodexRemoteHooks(existing:Record<string,any>,server='relay_remote'){
  const result=structuredClone(existing),added=codexRemoteHooks(server);result.hooks??={};
  for(const [event,groups] of Object.entries(added.hooks)){
    const prior=result.hooks[event]??[];
    if(!Array.isArray(prior))throw Error('Existing hook configuration needs review');
    result.hooks[event]=prior.map((group:any)=>({...group,hooks:(group.hooks??[]).filter((hook:any)=>!(hook.type==='mcp_tool'&&hook.server===server&&hook.tool==='relay_hook'))})).filter((group:any)=>group.hooks.length);
    result.hooks[event].push(...groups);
  }
  return result;
}
