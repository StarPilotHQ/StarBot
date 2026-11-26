import { describe, expect, it, vi } from 'vitest';
import type { ModalSubmitInteraction, ButtonInteraction, CommandInteraction } from 'discord.js';
vi.mock('../../store.js',()=>({createStore:()=>new Map()}));
vi.mock('../../config.js',()=>({loadConfig:()=>({guildId:'1387432184121393333',staffRole:'sage'})}));
vi.mock('../../logger.js',()=>({createLogger:()=>({info:vi.fn(),warn:vi.fn(),error:vi.fn()})}));
vi.mock('./title-generator.js',()=>({titleGenerator:{generate:async()=>null}}));
import { DrivingTransfers, parseOpener, reportFromStarter, suggestsDriving } from './companion-discord.js';
import { BotReport } from './index.js';

describe('Discord referral entry points',()=>{
  it.each(['manual','automatic'])('pings exactly the three reviewers once when %s review comes first',async first=>{
    const guildId='1387432184121393333';
    const id=first==='manual'?'1000000000000000051':'1000000000000000052';
    const send=vi.fn(async (_payload:unknown)=>({id:'card'}));
    const room={type:12,isSendable:()=>true,isThread:()=>true,permissionsFor:()=>({has:()=>true}),send};
    const guild={members:{me:{},fetch:async()=>({roles:{cache:new Map([['sage',true]])}})},channels:{fetch:async()=>room}};
    const thread={id,guildId,guild,parentId:'1565235002734809168',url:'https://discord.com/channels/'+guildId+'/'+id,
      isThread:()=>true,messages:{fetch:async()=>({author:{id:'1574857862872703088'},components:[],
        content:'Report from <@1000000000000000042> (user)\nReference: abc\n\nSteering wobble @everyone'})}};
    const handler=new DrivingTransfers();
    const manual=()=>handler.manual({channel:thread,guild,user:{id:'staff'},deferReply:vi.fn(),editReply:vi.fn()} as unknown as CommandInteraction);
    const auto=()=>handler.newThread([thread,true] as unknown as Parameters<typeof handler.newThread>[0]);
    if(first==='manual'){await manual();await auto();}else{await auto();await manual();}
    const users=['524762496373096459','420178305073938433','446126627701915653'];
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      content:users.map(id=>'<@'+id+'>').join(' '),allowedMentions:{parse:[],users},
    }));
  });
  it.each(['modern','verified legacy','unverified legacy'])('reports the correct failure stage for a %s StarPort ticket',async kind=>{
    const guildId='1387432184121393333', threadId='1000000000000000049', reporter='1000000000000000042', bot='1574857862872703088';
    const guild={members:{fetch:async()=>({roles:{cache:new Map([['sage',true]])}})},channels:{fetch:vi.fn(async()=>null)}};
    const first={author:{id:kind==='modern'?bot:'legacy'},webhookId:kind==='modern'?null:'1000000000000000099',
      content:'Report from <@'+reporter+'> (name)\nReference: abc\n\nStarPort test',components:[]};
    const history=[{author:{id:kind==='verified legacy'?bot:'untrusted'},components:[{toJSON:()=>({type:1,components:[{custom_id:'case:'+reporter+':ios:menu'}]})}]}];
    const thread={id:threadId,parentId:'1565235002734809168',guildId,guild,isThread:()=>true,
      messages:{fetch:async(arg:{message?:string})=>arg.message?first:history}};
    const editReply=vi.fn();
    await new DrivingTransfers().manual({channel:thread,guild,user:{id:'staff'},deferReply:vi.fn(),editReply} as unknown as CommandInteraction);
    expect(editReply).toHaveBeenCalledWith(expect.stringContaining(kind==='unverified legacy'?'Verify its ID':'StarBot cannot see'));
    expect(guild.channels.fetch).toHaveBeenCalledTimes(kind==='unverified legacy'?0:1);
  });
  it.each(['StarPort','Android app','iOS app','Bluetooth controller','Galaxy network'])('reads %s reports without relying on category tags',kind=>{
    const header='Report from <@1000000000000000042> (reporter)\r\nFor <@1000000000000000043>\r\nReference: abc-123';
    const description=kind+' stopped working.';
    const expected={reporterId:'1000000000000000042',publicDescription:description};
    expect(reportFromStarter(header+'\r\n\r\n'+description,[])).toEqual(expected);
    expect(reportFromStarter('',[{type:17,components:[{type:10,content:header+'\n\n'+description+'\nPrivate diagnostics: secret'}]}])).toEqual(expected);
    expect(reportFromStarter('',[{type:17,components:[{type:9,components:[{type:10,content:header+'\n'}]},{type:10,content:description}]}])).toEqual(expected);
  });
  it('rejects a missing route in the normal bug form before accessing a forum',async()=>{
    const editReply=vi.fn();
    await new BotReport().bugModal({customId:'bug_modal',user:{id:'member'},deferReply:vi.fn(),editReply,
      fields:{getTextInputValue:(key:string)=>key==='route_id'?'':'observed'}} as unknown as ModalSubmitInteraction);
    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({content:expect.stringContaining('Invalid route ID')}));
  });
  it('checks the staff role on click before accessing any ticket or sending a public message',async()=>{
    const fetch=vi.fn(); const reply=vi.fn();
    await new DrivingTransfers().decision({customId:'drivemove_1000000000000000042',channelId:'1575000066366644244',
      guildId:'1387432184121393333',user:{id:'member'},guild:{members:{fetch:async()=>({roles:{cache:new Map()}})},channels:{fetch}},
      deferReply:vi.fn(),editReply:reply} as unknown as ButtonInteraction);
    expect(fetch).not.toHaveBeenCalled(); expect(reply).toHaveBeenCalledOnce();
  });
  it('extracts the original reporter and the public description',()=>{
    expect(parseOpener('Report from <@1000000000000000042> (user)\nFor <@1000000000000000043>\nReference: abc-123\n\nSteering wobble\nPrivate diagnostics: private')).toEqual({
      reporterId:'1000000000000000042',publicDescription:'Steering wobble'});
    expect(suggestsDriving('Steering wobble')).toBe(true);
    expect(suggestsDriving('The phone app crashed opening my route')).toBe(false);
  });
});
