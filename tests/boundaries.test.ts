import { expect,it,vi } from 'vitest';
import { testStore } from './database';
import { player } from './fixtures';
import { unlinkAccount } from '../src/services/unlink';

it('keeps unrelated timers intact and setup of the same clan idempotent',async()=>{
 const {store,sqlite}=testStore();try{
 await store.user(1);await store.bind(1,player);await store.postpone(player.tag,3600);
 await store.setup(-100,'Group',1,player.clan!);
 await store.saveState(-100,1,'Manual','ok');
 await store.setup(-100,'Group',1,player.clan!);
 expect((await store.state(-100,1))?.applied_tag).toBe('Manual');
 await store.setup(-200,'Other',1,{tag:'#Q2Y',name:'Other'});
 expect(await store.due(8)).toEqual([]);
 expect(await store.manualBatch(-200,8)).toEqual([]);
 }finally{sqlite.close();}
});
it('preserves cooldown after unlink and a different tag',async()=>{
 const {store,sqlite}=testStore();try{
 await store.user(1);await store.bind(1,player);
 expect(await store.reserveInitial(1,player.tag)).toBe(true);
 await store.unlink(1);await store.bind(1,{...player,tag:'#P2Y'});
 expect(await store.reserveInitial(1,'#P2Y')).toBe(false);
 expect(await store.due(8)).toEqual([]);
 }finally{sqlite.close();}
});
it('cleans only its own tag, preserves manual edits and reports cleanup failure',async()=>{
 const {store,sqlite}=testStore();try{
 await store.user(1);await store.bind(1,player);await store.setup(-100,'Group',1,player.clan!);
 await store.setup(-200,'Group',1,player.clan!);await store.setup(-300,'Group',1,player.clan!);
 for(const chat of [-100,-200,-300])await store.saveState(chat,1,'Archer','ok');
 const api={getChatMember:vi.fn(async(chat:number)=>{if(chat===-300)throw Error();return {status:'member',tag:chat===-100?'Archer':'Manual'};}),setChatMemberTag:vi.fn(async()=>true)};
 expect(await unlinkAccount(store,api,1)).toBe(true);
 expect(api.setChatMemberTag).toHaveBeenCalledTimes(1);
 expect(api.setChatMemberTag).toHaveBeenCalledWith(-100,1,'');
 expect(await store.link(1)).toBeNull();
 }finally{sqlite.close();}
});
it('clan change cancels its queue without deleting other group state',async()=>{
 const {store,sqlite}=testStore();try{
 await store.user(1);await store.bind(1,player);await store.setup(-100,'Group',1,player.clan!);await store.setup(-200,'Group',1,player.clan!);
 await store.queueSync(-100,1);await store.queueSync(-200,1);await store.setup(-100,'Group',1,{tag:'#P2Y',name:'Changed'});
 expect(await store.syncJob(-100)).toBeNull();expect(await store.syncJob(-200)).not.toBeNull();
 }finally{sqlite.close();}
});
