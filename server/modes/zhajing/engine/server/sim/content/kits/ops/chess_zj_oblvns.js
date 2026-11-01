// 丰川祥子: all three skills, moving notes, composite range and the two talents / LOR-Y module.
import { addFever, isFeverActive } from '../../mujica.js';
import { installNotes } from '../shared/mujicaNotes.js';
import { num, talentBb, bbOf, skillData, live, mates, isMujica, ensureMujica, enemiesInGrid, aura, attackEvent, fixedLoop } from '../shared/mujica.js';
export default { chess_zj_oblvns_a: (bb, chess) => {
  const t0 = talentBb(chess, 0), t1 = talentBb(chess, 1), tb = chess.trait?.bb || {};
  const b1 = bbOf(chess, 'skchr_oblvns_1'), b2 = bbOf(chess, 'skchr_oblvns_2'), b3 = bbOf(chess, 'skchr_oblvns_3');
  const moduleRanged = chess.module?.active && chess.module.level >= 2;
  const ranged = (u, on) => moduleRanged && (on || u.skill?.id === 'skchr_oblvns_2') ? 1 : num(tb.atk_scale, 0.8);
  return {
    trait: { noAttack: true },
    skills: {
      skchr_oblvns_1: {
        kind: 'instant',
        onStart({ battle: b, unit: u }) {
          const target = enemiesInGrid(b, u)[0] || null;
          for (let i=0;i<8;i++) u.mem.mujicaLaunch?.({ target, scale:num(b1[i===0?'atk_scale':`atk_scale_${i+1}`]), type:'arts', kind:'s1', color:'organ', projectile:`projectile_chr_oblvns_s1_${i+1}`, angle:(-13.125+3.75*i)*Math.PI/180, rangedScale:ranged(u,true), isSkill:true });
        },
      },
      skchr_oblvns_2: {
        kind: 'instant', trigger: 'SP_FULL',
        onStart({ battle: b, unit: u }) {
          if (isFeverActive(b,u)) return; // A full Fever activates without switching the current instrument.
          u.mem.mujicaOrgan = !u.mem.mujicaOrgan;
          u.form = u.mem.mujicaOrgan ? 'oblvns_s2_b' : 'oblvns_s2_a';
          b.fx('setForm', { x:u.x,y:u.y,id:u.id,form:u.form });
        },
      },
      skchr_oblvns_3: {
        kind: 'duration', targeting: { rangeGrid: skillData(chess,'skchr_oblvns_3').rangeGrid },
        mods: { aspd: num(b3['attack@attack_speed']) },
      },
    },
    install(b,u) {
      ensureMujica(b);
      const launch=u.mem.mujicaLaunch=installNotes(b,u);
      const switchSkill=u.skill?.id==='skchr_oblvns_2';
      u.mem.mujicaSwitchSkill=switchSkill;
      const initial=()=>{ if(switchSkill) {u.mem.mujicaOrgan=false;u.form='oblvns_s2_a';b.fx('setForm',{x:u.x,y:u.y,id:u.id,form:u.form});} };
      b.on('deploy',({unit,move})=>{if(unit===u&&!move)initial();},{owner:u});
      b.every(0.25,()=>{
        if(!live(u))return;
        if(switchSkill) aura(b,u,'mujica:instrument',[u],u.mem.mujicaOrgan?{aspd:num(b2['attack@attack_speed'])}:{atkPct:num(b2['attack@atk'])});
        if(num(t1.enable)>0){
          const original=new Set(u.baseRangeKeys||[]), extra=new Set();
          for(const a of mates(b,u)){
            if(a===u)continue;
            const keys=a.def.charId==='char_4182_oblvns'?(a.baseRangeKeys||[]):(a.rangeKeys||[]);
            if(keys.some(k=>original.has(k)))for(const k of keys)extra.add(k);
          }
          b.setExtraRange(u,[...extra]);
          aura(b,u,'mujica:oblvns:speed',b.alliesInGrid(u),{aspd:num(t1.attack_speed)});
        }
        if(num(tb.attack_speed)>0 && enemiesInGrid(b,u).length>=2)aura(b,u,'mujica:oblvns:module',[u],{aspd:tb.attack_speed});
      },{owner:u});
      b.on('hit',c=>{
        if(c.source===u&&c.target.side==='enemy')addFever(b,u,num(t1.cnt,3));
        if(!live(u)||!isMujica(c.source)||c.source.ownerId!==u.ownerId||c.target.side!=='enemy')return;
        const count=Math.min(num(t0.max_cnt,10),u.mem.mujicaNotes.length);
        c.dmg.defIgnorePct+=count*num(t0.def_penetrate_ratio);
        c.dmg.resIgnorePct+=count*num(t0.magic_resist_penetrate_ratio);
      },{owner:u});
      fixedLoop(b,u,()=>u.s.interval,()=>{
        const targets=enemiesInGrid(b,u), on=u.skill?.active, s3=on&&u.skill.id==='skchr_oblvns_3';
        attackEvent(b,u,targets.slice(0,1),(selected,attackId)=>{
          const deployment=u.deploySeq;
          b.after((s3?0.2:8/30)*u.s.interval/1.3,()=>{
            if(!live(u)||u.deploySeq!==deployment||!u.canAct||u.s.flags.disarm)return;
            const now=enemiesInGrid(b,u), target=live(selected[0])?selected[0]:now[0]||null;
            if(s3){
              const phys=[...now].sort((a,z)=>z.s.res-a.s.res||a.spawnSeq-z.spawnSeq)[0]||null;
              const arts=[...now].sort((a,z)=>z.s.def-a.s.def||a.spawnSeq-z.spawnSeq)[0]||null;
              for(let i=0;i<2;i++){
                launch({target:phys,scale:num(b3['attack@atk_scale']),type:'phys',kind:'s3',color:'piano',rangedScale:ranged(u,true),isSkill:true,attackId});
                launch({target:arts,scale:num(b3['attack@atk_scale']),type:'arts',kind:'s3',color:'organ',rangedScale:ranged(u,true),isSkill:true,attackId});
              }
            }else if(switchSkill){
              const organ=!!u.mem.mujicaOrgan;
              const n=isFeverActive(b,u)?2:1;
              for(let i=0;i<n;i++)launch({target,type:organ?'arts':'phys',kind:organ?'organ':'piano',rangedScale:ranged(u,true),isSkill:true,attackId});
            }else launch({target,rangedScale:ranged(u,false),attackId});
          },{owner:u});
        },on||switchSkill);
        const sk=u.skill;
        if(sk?.id==='skchr_oblvns_1'&&sk.charges>=sk.maxCharges&&!sk.active&&!sk.opCooling)sk.activate('mujica-full');
      });
    },
  };
} };
