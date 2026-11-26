import { describe, expect, it, vi } from 'vitest';
import type { ModalSubmitInteraction, ButtonInteraction } from 'discord.js';
vi.mock('../../store.js',()=>({createStore:()=>({get:vi.fn(),set:vi.fn()})}));
vi.mock('../../config.js',()=>({loadConfig:()=>({guildId:'1387432184121393333',staffRole:'sage'})}));
vi.mock('../../logger.js',()=>({createLogger:()=>({info:vi.fn(),warn:vi.fn(),error:vi.fn()})}));
vi.mock('./title-generator.js',()=>({titleGenerator:{generate:async()=>null}}));
import { DrivingTransfers, parseOpener, suggestsDriving } from './companion-discord.js';
import { BotReport } from './index.js';

describe('Discord referral entry points',()=>{
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
