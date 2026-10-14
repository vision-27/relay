/** User-level hooks follow conversations everywhere; no workspace data is forwarded. */
// asyncRewake still enforces timeout even with async:true. These listeners wait
// for activity, unlike the short synchronous attachment and teardown hooks.
// Keep below the native signed 32-bit millisecond timer limit.
export const CLAUDE_LISTENER_TIMEOUT_SECONDS=7*24*60*60;
export function mergeClaudeSessionHooks(existing:Record<string,any>,node:string,entry:string,connection:string){
  const result=structuredClone(existing);result.hooks??={};
  for(const event of ['SessionStart','UserPromptSubmit','Stop','SessionEnd']){
    const prior=result.hooks[event]??[];if(!Array.isArray(prior))throw Error('Existing Claude hooks need review');
    result.hooks[event]=prior.map((group:any)=>({...group,hooks:(group.hooks??[]).filter((hook:any)=>!(hook.type==='command'&&hook.args?.some((arg:unknown)=>typeof arg==='string'&&/[\\/]claude-session-hook\.js$/.test(arg))))})).filter((group:any)=>group.hooks.length);
    const listener=['SessionStart','Stop'].includes(event);
    result.hooks[event].push({hooks:[{type:'command',command:node,args:[entry,connection],timeout:listener?CLAUDE_LISTENER_TIMEOUT_SECONDS:event==='SessionEnd'?2:30,...(listener?{async:true,asyncRewake:true}:{}),statusMessage:'Relay session connection'}]});
  }
  return result;
}
