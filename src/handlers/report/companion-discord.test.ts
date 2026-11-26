import { describe, expect, it, vi } from 'vitest';
import type { ModalSubmitInteraction, ButtonInteraction, CommandInteraction } from 'discord.js';
vi.mock('../../store.js',()=>({createStore:()=>({get:vi.fn(),set:vi.fn()})}));
vi.mock('../../config.js',()=>({loadConfig:()=>({guildId:'1387432184121393333',staffRole:'sage'})}));
vi.mock('../../logger.js',()=>({createLogger:()=>({info:vi.fn(),warn:vi.fn(),error:vi.fn()})}));
vi.mock('./title-generator.js',()=>({titleGenerator:{generate:async()=>null}}));
import { DrivingTransfers, parseOpener, reportFromStarter, suggestsDriving } from './companion-discord.js';
import { BotReport } from './index.js';

describe('Discord referral entry points',()=>{
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
