/** User-level hooks follow conversations everywhere; no workspace data is forwarded. */
export function mergeClaudeSessionHooks(existing:Record<string,any>,node:string,entry:string,connection:string){
  const result=structuredClone(existing);result.hooks??={};
  for(const event of ['SessionStart','UserPromptSubmit','Stop','SessionEnd']){
    const prior=result.hooks[event]??[];if(!Array.isArray(prior))throw Error('Existing Claude hooks need review');
    result.hooks[event]=prior.map((group:any)=>({...group,hooks:(group.hooks??[]).filter((hook:any)=>!(hook.type==='command'&&hook.args?.some((arg:unknown)=>typeof arg==='string'&&/[\\/]claude-session-hook\.js$/.test(arg))))})).filter((group:any)=>group.hooks.length);
    result.hooks[event].push({hooks:[{type:'command',command:node,args:[entry,connection],timeout:event==='SessionEnd'?2:30,...(['SessionStart','Stop'].includes(event)?{async:true,asyncRewake:true}:{}),statusMessage:'Relay session connection'}]});
  }
  return result;
}
