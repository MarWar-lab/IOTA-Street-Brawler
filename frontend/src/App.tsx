import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import "@iota/dapp-kit/dist/index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  IotaClientProvider,
  WalletProvider,
  ConnectButton,
  useCurrentAccount,
  useIotaClient,
  useSignAndExecuteTransaction,
} from "@iota/dapp-kit";
import { getFullnodeUrl } from "@iota/iota-sdk/client";
import { Transaction } from "@iota/iota-sdk/transactions";

// ═══════════════════════════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════════════════════════
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const sleepMs=ms=>new Promise(r=>setTimeout(r,ms));

// Small, deterministic hash + RNG (avoid Math.random() in core logic)
const hash32=s=>{let h=2166136261>>>0;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)>>>0;}return h>>>0;};
const makeRng=seed=>{let x=(seed>>>0)||1;return()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return((x>>>0)/4294967296);};};
const makeRngFrom=(...parts)=>makeRng(hash32(parts.filter(Boolean).join("|")));

// UX helpers
// ═══════════════════════════════════════════════════════════════════════════════
// IOTA WEB3 HELPERS (Wallet + Transactions + Object parsing)
// ═══════════════════════════════════════════════════════════════════════════════
const NETS={testnet:getFullnodeUrl("testnet"),mainnet:getFullnodeUrl("mainnet")};
const shortId=id=>id?`${id.slice(0,6)}…${id.slice(-4)}`:"";
const asFields=(obj)=>{
  try{
    const c=obj?.data?.content;
    // Move object typically: { data: { content: { dataType: "moveObject", fields: {...}}}}
    return c?.fields ?? c?.data?.fields ?? null;
  }catch{return null;}
};
const asType=(obj)=>obj?.data?.type ?? obj?.data?.content?.type ?? "";
const toNum=(v,def=0)=>{const n=Number(v);return Number.isFinite(n)?n:def;};
const iotaAmountFromUI=(s)=>{
  // Treat UI as "IOTA" where 1 IOTA = 1e9 nanos (adjust if your contract uses another unit).
  const x=Number(String(s??"").trim());
  if(!Number.isFinite(x)||x<=0) return 0n;
  return BigInt(Math.round(x*1e9));
};

const formatIota=(nanosLike)=>{
  try{
    const n=BigInt(nanosLike??0);
    const whole=n/1000000000n;
    const frac=n%1000000000n;
    const fracStr=String(frac).padStart(9,"0").slice(0,3);
    return `${whole}.${fracStr}`;
  }catch{
    return String(nanosLike??"0");
  }
};


// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS & RULES
// ═══════════════════════════════════════════════════════════════════════════════
const HP_MAX=120,ENERGY_MAX=10,HUNGER_MAX=100,STAM_MAX=6;
const HUNGER_TICK_MS=45000,ENERGY_TICK_MS=90000,HP_REGEN_MS=120000;
const ROUNDS_TO_WIN=2,ROUND_TIMER=18;

const RULES={
  minHungerToAct:10,minHpToFight:10,
  cost:{work:1,rob:2,fight:0,stakeFight:0},
  maxFightsDay:5,maxWorksDay:8,maxLossesDay:3,
  robBaseChance:60,jailMinSec:30,jailMaxSec:90,
  hungerPerWork:5,hungerPerRob:8,hungerPerFight:10,
  sleepEnergyGain:[3,5],
};

const C={bg:"#0B1220",card:"#0E1628",card2:"#111C34",border:"#1E2A4A",text:"#E6EEF8",
  sub:"#9FB2C9",muted:"#6B84A6",accent:"#00B4A6",gold:"#FFD54F",green:"#22c55e",
  red:"#ef4444",cyan:"#4DD0E1",purple:"#8b5cf6",ioBlue:"#00B4A6",ioLight:"#1DE9B6"};
const CLASS_COL={brawler:"#ef4444",hustler:"#06b6d4",schemer:"#8b5cf6"};
const CLASS_NAME={brawler:"Brawler",hustler:"Hustler",schemer:"Schemer"};

// ═══════════════════════════════════════════════════════════════════════════════
// XP / LEVEL / SKILL POINTS
// ═══════════════════════════════════════════════════════════════════════════════
const getXPForLevel=l=>l*150;
const getLevelFromXP=xp=>{let l=1;while(xp>=getXPForLevel(l+1))l++;return l;};
const getTotalSP=l=>Math.floor(l/3);
const getAvailSP=(l,sk)=>getTotalSP(l)-Object.keys(sk||{}).length;
const calcXP=({won,roundsWon=0,dmgDealt=0})=>{
  const raw=120+roundsWon*80+dmgDealt*0.4;return Math.max(40,Math.round(won?raw:raw*0.5));};

// ═══════════════════════════════════════════════════════════════════════════════
// SKILL TREES
// ═══════════════════════════════════════════════════════════════════════════════
const SKILL_EDGES=[[0,3],[0,4],[1,4],[1,5],[2,5],[3,6],[3,7],[4,7],[4,8],[5,8]];
const getPrereqs=id=>SKILL_EDGES.filter(([,b])=>b===id).map(([a])=>a);
const isUnlockable=(id,sk)=>{const p=getPrereqs(id);return p.length===0||p.some(x=>sk[x]);};
const SKILL_TREES={
  brawler:[
    {id:0,name:"Toughness",icon:"❤️",desc:"+10 HP",effect:{hpBonus:10}},
    {id:1,name:"Quick Hands",icon:"👊",desc:"+2 ATK",effect:{atkBonus:2}},
    {id:2,name:"Iron Skin",icon:"🛡",desc:"+2 DEF",effect:{defBonus:2}},
    {id:3,name:"Crit Eye",icon:"👁",desc:"+5% Crit",effect:{critBonus:5}},
    {id:4,name:"Stamina Well",icon:"⚡",desc:"+15% SCASH/work",effect:{workBonus:15}},
    {id:5,name:"Counter Edge",icon:"⚔️",desc:"Block deals 3 dmg",effect:{blockDmg:3}},
    {id:6,name:"Fury",icon:"🔥",desc:"+25% Kick dmg",effect:{kickMult:0.25}},
    {id:7,name:"Bloodlust",icon:"💉",desc:"+20 SCASH/win",effect:{winBonus:20}},
    {id:8,name:"BERSERKER",icon:"✨",desc:"+10% all dmg",effect:{allDmg:0.1},ultimate:true},
  ],
  hustler:[
    {id:0,name:"Toughness",icon:"❤️",desc:"+10 HP",effect:{hpBonus:10}},
    {id:1,name:"Quick Hands",icon:"👊",desc:"+2 ATK",effect:{atkBonus:2}},
    {id:2,name:"Iron Skin",icon:"🛡",desc:"+2 DEF",effect:{defBonus:2}},
    {id:3,name:"Crit Eye",icon:"👁",desc:"+5% Crit",effect:{critBonus:5}},
    {id:4,name:"Coin Magnet",icon:"💰",desc:"+20% SCASH/work",effect:{workBonus:20}},
    {id:5,name:"Counter Edge",icon:"⚔️",desc:"Block deals 3 dmg",effect:{blockDmg:3}},
    {id:6,name:"Ghost Proto",icon:"👻",desc:"+10% dodge",effect:{dodgeBonus:10}},
    {id:7,name:"Ace",icon:"🃏",desc:"+10% Crit",effect:{critBonus:10}},
    {id:8,name:"PHANTOM",icon:"✨",desc:"+60% rob success",effect:{robBonus:60},ultimate:true},
  ],
  schemer:[
    {id:0,name:"Toughness",icon:"❤️",desc:"+10 HP",effect:{hpBonus:10}},
    {id:1,name:"Quick Hands",icon:"👊",desc:"+2 ATK",effect:{atkBonus:2}},
    {id:2,name:"Iron Skin",icon:"🛡",desc:"+2 DEF",effect:{defBonus:2}},
    {id:3,name:"Crit Eye",icon:"👁",desc:"+5% Crit",effect:{critBonus:5}},
    {id:4,name:"Stamina Well",icon:"⚡",desc:"+15% SCASH/work",effect:{workBonus:15}},
    {id:5,name:"Poison Edge",icon:"☠️",desc:"+4 poison/fight",effect:{poisonDmg:4}},
    {id:6,name:"Toxicologist",icon:"🧪",desc:"+3 ATK",effect:{atkBonus:3}},
    {id:7,name:"Bleeder",icon:"🩸",desc:"+8% Crit",effect:{critBonus:8}},
    {id:8,name:"PLAGUE",icon:"✨",desc:"+15% all dmg",effect:{allDmg:0.15},ultimate:true},
  ],
};
const applySkills=(cls,sk={})=>{
  const tree=SKILL_TREES[cls]||[];
  const out={hpBonus:0,atkBonus:0,defBonus:0,critBonus:0,workBonus:0,blockDmg:0,
    kickMult:0,winBonus:0,allDmg:0,dodgeBonus:0,robBonus:0,poisonDmg:0};
  tree.forEach(n=>{if(!sk[n.id])return;const e=n.effect;
    Object.keys(e).forEach(k=>{if(typeof e[k]==="number")out[k]=(out[k]||0)+e[k];});});
  return out;};

// ═══════════════════════════════════════════════════════════════════════════════
// ITEMS & UPGRADES
// ═══════════════════════════════════════════════════════════════════════════════
const BASE_ITEMS=[
  {id:"bat",name:"Baseball Bat",icon:"🏏",baseAtk:3,baseDef:0,cost:300,slot:"weapon",maxTier:3},
  {id:"knife",name:"Switchblade",icon:"🔪",baseAtk:5,baseDef:0,cost:500,slot:"weapon",maxTier:3},
  {id:"chain",name:"Chain Whip",icon:"⛓️",baseAtk:4,baseDef:1,cost:450,slot:"weapon",maxTier:3},
  {id:"brass",name:"Brass Knuckles",icon:"🥊",baseAtk:6,baseDef:0,cost:650,slot:"weapon",maxTier:3},
  {id:"shield",name:"Riot Shield",icon:"🛡️",baseAtk:0,baseDef:4,cost:400,slot:"offhand",maxTier:3},
  {id:"armor",name:"Body Armor",icon:"🦺",baseAtk:0,baseDef:6,cost:700,slot:"offhand",maxTier:3},
];
const UPGRADE_BONUS=2;
const UPGRADE_COST_MULT=[0,1.5,2.5];
const getItemStats=(id,tier=0)=>{const b=BASE_ITEMS.find(i=>i.id===id);if(!b)return{atk:0,def:0};
  return{atk:b.baseAtk+tier*UPGRADE_BONUS*(b.baseAtk>0?1:0),def:b.baseDef+tier*UPGRADE_BONUS*(b.baseDef>0?1:0)};};
const getUpgradeCost=(id,tier)=>{const b=BASE_ITEMS.find(i=>i.id===id);if(!b||tier>=b.maxTier)return Infinity;
  return Math.round(b.cost*UPGRADE_COST_MULT[tier]);};
const TIER_NAMES=["Base","★ Tier 2","★★ Tier 3","★★★ MAX"];
const TIER_COLORS=["#4a6a8a","#3b82f6","#a855f7","#f59e0b"];
// ═══════════════════════════════════════════════════════════════════════════════
// NFT ART (embedded SVG) + MILESTONE REWARDS
// - These are "wallet-friendly" previews (data URIs) you can later replace with
//   on-chain metadata image_url pointing to IPFS/Arweave.
// - Milestones: 10/20/30/40/50. At each milestone, UI surfaces a claim action.
// ═══════════════════════════════════════════════════════════════════════════════
const WEAPON_MILESTONES=[10,20,30,40,50];

const svgToDataUri=(svg)=>{
  const enc=encodeURIComponent(svg).replace(/'/g,"%27").replace(/"/g,"%22");
  return `data:image/svg+xml;charset=utf-8,${enc}`;
};

const milestoneArt = (milestone, name="Weapon")=>{
  const glow = milestone>=40 ? "#f59e0b" : milestone>=30 ? "#8b5cf6" : milestone>=20 ? "#06b6d4" : "#3b82f6";
  const accent = milestone>=50 ? "#00d4ff" : "#e2e8f0";
  const tag = milestone===10?"Mk I":milestone===20?"Mk II":milestone===30?"Mk III":milestone===40?"Mk IV":"Mk V";
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="512" height="256" viewBox="0 0 512 256">
    <defs>
      <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
        <stop offset="0" stop-color="#050d1a"/>
        <stop offset="1" stop-color="#0b1a2e"/>
      </linearGradient>
      <filter id="g" x="-30%" y="-30%" width="160%" height="160%">
        <feGaussianBlur stdDeviation="6" result="b"/>
        <feMerge>
          <feMergeNode in="b"/>
          <feMergeNode in="SourceGraphic"/>
        </feMerge>
      </filter>
    </defs>
    <rect width="512" height="256" fill="url(#bg)"/>
    <g filter="url(#g)" opacity="0.9">
      <path d="M110 170 L200 80 L225 105 L135 195 Z" fill="${glow}" opacity="0.55"/>
      <path d="M210 75 L380 245 L410 215 L240 45 Z" fill="${glow}" opacity="0.35"/>
    </g>
    <g>
      <path d="M150 188 L236 102 L262 128 L176 214 Z" fill="${accent}" opacity="0.9"/>
      <path d="M250 58 L442 250 L474 218 L282 26 Z" fill="${accent}" opacity="0.9"/>
      <rect x="270" y="38" width="38" height="38" rx="10" fill="${glow}"/>
      <rect x="318" y="86" width="38" height="38" rx="10" fill="${glow}"/>
      <rect x="366" y="134" width="38" height="38" rx="10" fill="${glow}"/>
    </g>
    <g>
      <text x="28" y="54" fill="#e2e8f0" font-size="20" font-family="ui-sans-serif, system-ui" font-weight="900">${name}</text>
      <text x="28" y="80" fill="#94a3b8" font-size="14" font-family="ui-sans-serif, system-ui" font-weight="700">Milestone ${milestone} • ${tag}</text>
      <text x="28" y="112" fill="${glow}" font-size="14" font-family="ui-sans-serif, system-ui" font-weight="800">IOTA ARMORY NFT</text>
    </g>
    <g opacity="0.25">
      <circle cx="468" cy="48" r="18" fill="${glow}"/>
      <circle cx="468" cy="48" r="9" fill="#050d1a"/>
      <circle cx="440" cy="66" r="7" fill="#00d4ff"/>
    </g>
  </svg>`;
  return { tag, uri: svgToDataUri(svg), glow };
};

const getMilestoneForLevel=(lvl)=>{
  let m=0;
  for(const x of WEAPON_MILESTONES) if(lvl>=x) m=x;
  return m;
};


// ═══════════════════════════════════════════════════════════════════════════════
// FOODS
// ═══════════════════════════════════════════════════════════════════════════════
const FOODS=[
  {id:"energy",name:"Energy Drink",icon:"🥤",cost:25,hunger:15,hp:3},
  {id:"burger",name:"Street Burger",icon:"🍔",cost:35,hunger:25,hp:5},
  {id:"pizza",name:"Pizza Slice",icon:"🍕",cost:50,hunger:35,hp:10},
  {id:"ramen",name:"Ramen Bowl",icon:"🍜",cost:75,hunger:45,hp:15},
  {id:"steak",name:"Steak Dinner",icon:"🥩",cost:120,hunger:60,hp:25},
];

// ═══════════════════════════════════════════════════════════════════════════════
// FIGHT SYSTEM
// ═══════════════════════════════════════════════════════════════════════════════
const FIGHT_MOVES={
  jab:{label:"Jab",icon:"👊",key:"A",cost:0.5,atkMult:1.0,defMult:0},
  cross:{label:"Cross",icon:"🤜",key:"S",cost:0.75,atkMult:1.2,defMult:0},
  heavy:{label:"Heavy",icon:"💥",key:"D",cost:1.0,atkMult:1.45,defMult:0},
  block:{label:"Block",icon:"🛡",key:"F",cost:-1.5,atkMult:0,defMult:1.15},
  special:{label:"Special",icon:"✨",key:"Sp",cost:0,atkMult:0,defMult:0},
};
const FIGHT_CLASSES={
  brawler:{atk:10,def:8,crit:12,specialName:"RAGE",specialCost:3,specialDmg:28,specialDef:0},
  hustler:{atk:9,def:7,crit:14,specialName:"GHOST",specialCost:3,specialDmg:0,specialDef:0,dodge:true},
  schemer:{atk:9,def:6,crit:13,specialName:"VENOM",specialCost:3,specialDmg:15,specialDef:0,poison:6},
};
const COMBO_WINDOW_MS=3000;
const COMBOS={
  brawler:[{seq:["jab","jab","heavy"],name:"Haymaker",mult:1.4,icon:"💫"}],
  hustler:[{seq:["jab","cross","special"],name:"Ghost Strike",mult:1.3,icon:"👻"}],
  schemer:[{seq:["cross","cross","special"],name:"Venom Burst",mult:1.5,icon:"☠️"}],
};

function calcDmg(atkMove,defMove,atkCls,defCls,atkBonus,defBonus,opts={}){
  const rand=opts.rand||Math.random;
  if(atkMove==="block")return{dmg:opts.blockDmg||0,crit:false,blocked:false};
  if(atkMove==="special"){
    if(atkCls.dodge)return{dmg:0,crit:false,blocked:false,ghostDodge:true};
    let d=atkCls.specialDmg||0;if(opts.allDmg)d=Math.round(d*(1+opts.allDmg));
    return{dmg:d,crit:false,blocked:false,poison:atkCls.poison||0};}
  const mv=FIGHT_MOVES[atkMove]||FIGHT_MOVES.jab;
  let raw=Math.round(atkCls.atk*mv.atkMult)+atkBonus;
  if((atkMove==="cross"||atkMove==="heavy")&&opts.kickMult)raw=Math.round(raw*(1+opts.kickMult));
  if(opts.allDmg)raw=Math.round(raw*(1+opts.allDmg));
  const critChance=(atkCls.crit||0)+(opts.critBonus||0);
  const crit=rand()*100<critChance;
  let after=crit?Math.round(raw*1.6):raw;
  if(opts.rage)after=Math.round(after*2.5);
  const defMv=FIGHT_MOVES[defMove]||FIGHT_MOVES.jab;
  const defVal=Math.round(defCls.def*defMv.defMult+defBonus);
  if(opts.defDodgeBonus&&rand()*100<opts.defDodgeBonus)return{dmg:0,crit:false,blocked:true};
  return{dmg:Math.max(1,after-defVal),crit,blocked:defMove==="block"};}

const LEADERBOARD=[
  {rank:1,name:"DeathMachine",cls:"schemer",elo:1820,wins:312,losses:44},
  {rank:2,name:"StreetKing",cls:"hustler",elo:1710,wins:245,losses:61},
  {rank:3,name:"BladeRunner-3",cls:"brawler",elo:1650,wins:198,losses:55},
  {rank:4,name:"IronFist",cls:"brawler",elo:1580,wins:177,losses:70},
  {rank:5,name:"CryptoSlayer",cls:"hustler",elo:1490,wins:143,losses:82},
];

// ═══════════════════════════════════════════════════════════════════════════════
// ANIMATIONS CSS
// ═══════════════════════════════════════════════════════════════════════════════
const ANIM=`

@keyframes toast{from{opacity:0;transform:translateX(-50%) translateY(-12px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
@keyframes pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.12);opacity:.75}}
@keyframes countdown{from{transform:scale(2.2);opacity:0}to{transform:scale(1);opacity:1}}
@keyframes fadein{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes dmgpop{0%{transform:translateY(0) scale(1.3);opacity:1}100%{transform:translateY(-18px) scale(0.8);opacity:0}}
@keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
*{box-sizing:border-box;margin:0;padding:0}body{background:#0B1220}input,button,select{font-family:inherit}
::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:#091423}::-webkit-scrollbar-thumb{background:#1a3050;border-radius:2px}


:root{color-scheme:dark}
body{
  background:
    radial-gradient(circle at 20% 10%, rgba(29,233,182,.12), transparent 40%),
    radial-gradient(circle at 80% 0%, rgba(77,208,225,.10), transparent 35%),
    radial-gradient(circle at 50% 120%, rgba(0,180,166,.10), transparent 45%),
    linear-gradient(180deg,#070D18,#0B1220 40%,#070D18);
}
.proWrap{max-width:1120px;margin:0 auto;padding:18px 18px 90px;min-height:100vh}
.proDot{
  position:absolute;inset:0;pointer-events:none;opacity:.55;
  background-image:radial-gradient(rgba(255,255,255,.06) 1px, transparent 1px);
  background-size:16px 16px;
  mask-image:linear-gradient(180deg, transparent, #000 15%, #000 85%, transparent);
}
.proHeader{
  display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:12px 14px;border:1px solid rgba(30,42,74,.9);border-radius:14px;
  background:linear-gradient(180deg, rgba(17,28,52,.95), rgba(14,22,40,.80));
  box-shadow:0 8px 30px rgba(0,0,0,.45);
  margin-bottom:14px;
}
.proHeaderLeft{display:flex;align-items:center;gap:10px;min-width:0}
.proTitle{font-weight:950;letter-spacing:.6px;font-size:14px;color:#E6EEF8;white-space:nowrap}
.proSub{font-size:10px;color:#9FB2C9;margin-top:2px;white-space:nowrap;opacity:.9}
.proIconBtn{
  width:34px;height:34px;border-radius:10px;border:1px solid rgba(30,42,74,.9);
  background:rgba(17,28,52,.75);color:#9FB2C9;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  transition:transform .12s, box-shadow .12s, border-color .12s;
}
.proIconBtn:hover{transform:translateY(-1px);border-color:rgba(0,180,166,.7);box-shadow:0 0 16px rgba(0,180,166,.18)}
.proHomeGrid{display:grid;grid-template-columns: 1.25fr .75fr;gap:14px;align-items:start}
@media(max-width: 980px){.proHomeGrid{grid-template-columns:1fr}.proTitle{font-size:13px}}

`;

// ═══════════════════════════════════════════════════════════════════════════════
// UI PRIMITIVES
// ═══════════════════════════════════════════════════════════════════════════════
const Panel=({children,glow,style:s})=>(
  <div style={{position:"relative",background:`linear-gradient(180deg,${C.card2},${C.card})`,border:`1px solid ${glow?C.accent:C.border}`,borderRadius:14,padding:14,marginBottom:12,boxShadow:glow?`0 0 26px ${C.accent}26`:"0 10px 34px rgba(0,0,0,.45)",backdropFilter:"blur(6px)",...s}}>{children}</div>);
const Chip=({color=C.accent,children,style:s})=>(
  <span style={{display:"inline-block",padding:"2px 8px",borderRadius:99,background:color+"22",
    border:`1px solid ${color}44`,color,fontSize:10,fontWeight:700,...s}}>{children}</span>);
const Btn=({children,onClick,color=C.accent,disabled,full,sm,style:s})=>(
  <button onClick={disabled?undefined:onClick} disabled={disabled}
    style={{background:disabled?"#1a2a3a":color+"22",color:disabled?"#4a5568":color,
      border:`2px solid ${disabled?"#2a3a4a":color}`,borderRadius:12,
      padding:sm?"5px 12px":"10px 16px",fontWeight:900,fontSize:sm?10:12,
      cursor:disabled?"not-allowed":"pointer",width:full?"100%":"auto",
      transition:"all .15s",opacity:disabled?0.5:1,...s}}>{children}</button>);const btnSm=(color)=>({
  padding:"6px 12px",
  borderRadius:12,
  border:`1px solid ${color}66`,
  background:color+"22",
  color,
  cursor:"pointer",
  fontSize:11,
  fontWeight:900,
});

const Input=({label,value,onChange,ph})=>(
  <label style={{fontSize:11,color:C.sub}}>
    {label}
    <input value={value} placeholder={ph||""} onChange={e=>onChange(e.target.value)}
      style={{width:"100%",marginTop:4,background:C.card2,border:`1px solid ${C.border}`,color:C.text,borderRadius:10,padding:"8px 10px"}}/>
  </label>
);

const Bar=({v,max,color,icon,label})=>{
  const pct=clamp((v/max)*100,0,100);
  const c=pct<20?C.red:pct<40?"#f97316":color;
  return(<div style={{marginBottom:5}}>
    <div style={{display:"flex",justifyContent:"space-between",fontSize:10,marginBottom:2}}>
      <span style={{color:C.muted}}>{icon} {label}</span>
      <span style={{color:c,fontWeight:700}}>{Math.round(v)}/{max}</span></div>
    <div style={{height:7,background:"#0a1628",borderRadius:99,border:`1px solid ${C.border}`,overflow:"hidden"}}>
      <div style={{height:"100%",width:`${pct}%`,background:c,borderRadius:99,
        boxShadow:`0 0 8px ${c}88`,transition:"width .4s ease"}}/></div></div>);};

const ActRow=({ic,label,amount,pos,tx})=>(
  <div style={{display:"flex",alignItems:"center",gap:8,padding:"5px 0",borderBottom:`1px solid ${C.border}22`,fontSize:11}}>
    <span style={{fontSize:14}}>{ic}</span>
    <div style={{flex:1,minWidth:0}}>
      <div style={{color:C.text,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{label}</div>
      {tx&&<div style={{fontSize:8,color:C.cyan,fontFamily:"monospace"}}>⬡ {tx.slice(0,16)}… <span style={{textDecoration:"underline"}}>View on Explorer ↗</span></div>}
    </div>
    <div style={{color:pos?C.green:C.red,fontWeight:900,fontSize:12}}>{pos?"+":""}{amount}</div>
  </div>);

const Notif=({n})=>n?<div style={{position:"fixed",top:14,left:"50%",transform:"translateX(-50%)",
  zIndex:999,padding:"10px 20px",borderRadius:12,fontSize:12,fontWeight:700,maxWidth:380,textAlign:"center",
  whiteSpace:"pre-wrap",animation:"toast .3s ease",
  background:n.type==="error"?"#7f1d1d":n.type==="success"?"#14532d":n.type==="chain"?"#0c2340":"#1e293b",
  color:n.type==="error"?C.red:n.type==="success"?C.green:n.type==="chain"?C.cyan:C.text,
  border:`1px solid ${n.type==="error"?C.red:n.type==="success"?C.green:n.type==="chain"?C.cyan:C.border}`}}>{n.msg}</div>:null;

function XPBar({xp=0,name="",classId="brawler"}){
  const lvl=getLevelFromXP(xp),curr=xp-getXPForLevel(lvl),need=getXPForLevel(lvl+1)-getXPForLevel(lvl);
  const pct=Math.min(100,Math.round((curr/need)*100)),col=CLASS_COL[classId]||C.accent;
  return <div style={{display:"flex",alignItems:"center",gap:8,minWidth:140}}>
    <div style={{flexShrink:0,width:26,height:26,borderRadius:"50%",background:`radial-gradient(circle,${col},${col}88)`,
      border:`2px solid ${col}`,display:"flex",alignItems:"center",justifyContent:"center",
      fontWeight:900,fontSize:11,color:"#fff",boxShadow:`0 0 10px ${col}88`}}>{lvl}</div>
    <div style={{flex:1,minWidth:0}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
        <span style={{fontSize:10,fontWeight:700,color:C.text}}>{name}</span>
        <span style={{fontSize:8,color:C.muted}}>{curr}/{need} XP</span></div>
      <div style={{height:4,background:"#0a1628",borderRadius:99,border:`1px solid ${C.border}`,overflow:"hidden"}}>
        <div style={{height:"100%",width:`${pct}%`,background:col,borderRadius:99,transition:"width .6s ease"}}/></div>
    </div></div>;}

// ═══════════════════════════════════════════════════════════════════════════════
// FIGHTER SVG (South Park style)
// ═══════════════════════════════════════════════════════════════════════════════
const PRESETS={
  brawler:{skin:"#f5c5a3",hair:"#2d1a0e",shirt:"#cc2200",pants:"#1a1a4e",acc:"bandana"},
  hustler:{skin:"#d4a574",hair:"#111",shirt:"#0033ad",pants:"#222",acc:"sunglasses"},
  schemer:{skin:"#e8d5b7",hair:"#4a0080",shirt:"#330033",pants:"#1a1a2e",acc:"mohawk",cape:true},
};

function FighterSVG({classId="brawler",pose="idle",flip=false,w=110,weaponId=null,offhandId=null}){
  const p=PRESETS[classId]||PRESETS.brawler;
  const po={idle:{by:0,br:0,ra:-14,la:14},jab:{by:0,br:8,ra:-115,la:-22},
    cross:{by:0,br:14,ra:-108,la:-28},heavy:{by:0,br:20,ra:-138,la:-55},
    block:{by:0,br:0,ra:-58,la:-55},special:{by:-3,br:0,ra:-95,la:-90},
    hit:{by:0,br:-15,ra:-18,la:-8},ko:{by:14,br:-40,ra:25,la:18},win:{by:0,br:0,ra:-120,la:-120}};
  const o=po[pose]||po.idle;
  const wItem=weaponId?BASE_ITEMS.find(i=>i.id===weaponId):null;
  const oItem=offhandId?BASE_ITEMS.find(i=>i.id===offhandId):null;
  return(
    <svg viewBox="0 0 110 160" width={w} style={{transform:flip?"scaleX(-1)":"none",transition:"transform .15s"}}>
      <g transform={`translate(55,80) rotate(${o.br}) translate(-55,-80) translate(0,${o.by})`}>
        <rect x="42" y="118" width="10" height="30" rx="5" fill={p.pants}/>
        <rect x="58" y="118" width="10" height="30" rx="5" fill={p.pants}/>
        <rect x="40" y="145" width="14" height="8" rx="4" fill="#333"/>
        <rect x="56" y="145" width="14" height="8" rx="4" fill="#333"/>
        <rect x="38" y="78" width="34" height="42" rx="6" fill={p.shirt}/>
        <text x="55" y="100" textAnchor="middle" fontSize="10" fontWeight="900" fill={C.ioLight}>⬡</text>
        <g transform={`rotate(${o.ra},42,80)`}>
          <rect x="28" y="78" width="12" height="30" rx="6" fill={p.skin}/>
          {wItem&&<text x="22" y="112" fontSize="14">{wItem.icon}</text>}
        </g>
        <g transform={`rotate(${o.la},68,80)`}>
          <rect x="70" y="78" width="12" height="30" rx="6" fill={p.skin}/>
          {oItem&&<text x="74" y="112" fontSize="14">{oItem.icon}</text>}
        </g>
        <circle cx="55" cy="58" r="22" fill={p.skin}/>
        <ellipse cx="55" cy="40" rx="20" ry="10" fill={p.hair}/>
        {p.acc==="bandana"&&<rect x="38" y="50" width="34" height="5" rx="2" fill={C.red}/>}
        {p.acc==="sunglasses"&&<rect x="40" y="53" width="30" height="7" rx="3" fill="#111" opacity="0.9"/>}
        {p.acc==="mohawk"&&<path d="M48 36 Q55 15 62 36" fill={p.hair} stroke={p.hair} strokeWidth="3"/>}
        <circle cx="47" cy="57" r="3" fill="#fff"/><circle cx="47" cy="57" r="1.5" fill="#111"/>
        <circle cx="63" cy="57" r="3" fill="#fff"/><circle cx="63" cy="57" r="1.5" fill="#111"/>
        {pose==="ko"&&<><line x1="44" y1="54" x2="50" y2="60" stroke="#555" strokeWidth="2"/>
          <line x1="50" y1="54" x2="44" y2="60" stroke="#555" strokeWidth="2"/>
          <line x1="60" y1="54" x2="66" y2="60" stroke="#555" strokeWidth="2"/>
          <line x1="66" y1="54" x2="60" y2="60" stroke="#555" strokeWidth="2"/></>}
        {p.cape&&<path d="M42 80 Q38 130 30 145 L80 145 Q72 130 68 80 Z" fill={p.shirt} opacity="0.4"/>}
      </g>
      {pose==="ko"&&<text x="55" y="20" textAnchor="middle" fontSize="16" fontWeight="900" fill={C.red}>KO!</text>}
      {pose==="win"&&<text x="55" y="20" textAnchor="middle" fontSize="12" fontWeight="900" fill={C.gold}>✨ WIN!</text>}
    </svg>);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FIGHT ARENA (Real-time SF-style Best-of-3)
// ═══════════════════════════════════════════════════════════════════════════════
function FightArena({ch,opp,onFinish,charHP,seed}){
  const myCls=FIGHT_CLASSES[ch.presetId]||FIGHT_CLASSES.brawler;
  const oppCls=FIGHT_CLASSES[opp.presetId]||FIGHT_CLASSES.brawler;
  const myWpn=ch.weapon?getItemStats(ch.weapon,ch.weaponTier||0):{atk:0,def:0};
  const myOff=ch.offhand?getItemStats(ch.offhand,ch.offhandTier||0):{atk:0,def:0};
  const oppWpn=opp.weapon?getItemStats(opp.weapon,0):{atk:0,def:0};
  const oppOff=opp.offhand?getItemStats(opp.offhand,0):{atk:0,def:0};
  const sb=applySkills(ch.presetId,ch.skills||{});
  const maxHP=HP_MAX+(sb.hpBonus||0);
  const startHP=clamp(charHP||maxHP,1,maxHP);

  const [myHP,setMyHP]=useState(startHP);
  const [oppHP,setOppHP]=useState(HP_MAX);
  const [myStam,setMyStam]=useState(STAM_MAX);
  const [oppStam,setOppStam]=useState(STAM_MAX);
  const [myRounds,setMyRounds]=useState(0);
  const [oppRounds,setOppRounds]=useState(0);
  const [roundNum,setRoundNum]=useState(1);
  const [timer,setTimer]=useState(ROUND_TIMER);
  const [phase,setPhase]=useState("countdown");
  const [countNum,setCountNum]=useState(3);
  const [myPose,setMyPose]=useState("idle");
  const [oppPose,setOppPose]=useState("idle");
  const [exLog,setExLog]=useState([]);
  const [bannerMsg,setBannerMsg]=useState("");
  const [shake,setShake]=useState(false);
  const [myMom,setMyMom]=useState(0);
  const [oppMom,setOppMom]=useState(0);
  const [comboMsg,setComboMsg]=useState("");
  const comboBufRef=useRef([]);

  const randRef=useRef(null);
  useEffect(()=>{randRef.current=makeRng((seed>>>0)||hash32((ch?.name||"")+"|"+(opp?.name||"")+"|"+Date.now()));},[seed,ch?.name,opp?.name]);
  const rand=useCallback(()=>(randRef.current?randRef.current():0.5),[]);
  const randInt=useCallback((a,b)=>Math.floor(rand()*(b-a+1))+a,[rand]);

  const totalDmgTakenRef=useRef(0);
  const totalDmgDealtRef=useRef(0);
  const myHPRef=useRef(startHP);const oppHPRef=useRef(HP_MAX);
  const myStamRef=useRef(STAM_MAX);const oppStamRef=useRef(STAM_MAX);
  const myRoundsRef=useRef(0);const oppRoundsRef=useRef(0);
  const myMomRef=useRef(0);const oppMomRef=useRef(0);
  const timerRef=useRef(null);const chosenRef=useRef(false);
  const roundStartMyHP=useRef(startHP);

  useEffect(()=>{myHPRef.current=myHP;},[myHP]);
  useEffect(()=>{oppHPRef.current=oppHP;},[oppHP]);
  useEffect(()=>{myStamRef.current=myStam;},[myStam]);
  useEffect(()=>{oppStamRef.current=oppStam;},[oppStam]);
  useEffect(()=>{myMomRef.current=myMom;},[myMom]);
  useEffect(()=>{oppMomRef.current=oppMom;},[oppMom]);

  const oppAI=useCallback(()=>{
    const st=oppStamRef.current,oHP=oppHPRef.current,mHP=myHPRef.current;
    const canSpec=st>=oppCls.specialCost;const r=randInt(1,100);
    if(canSpec&&oHP<HP_MAX*0.25)return"special";
    if(oHP<HP_MAX*0.3)return r<50?"heavy":r<72?"cross":"block";
    if(mHP<HP_MAX*0.25)return r<55?"heavy":"cross";
    return r<35?"jab":r<58?"cross":r<75?"heavy":r<88?"block":"jab";
  },[oppCls.specialCost,randInt]);

  const resetRound=useCallback((isFirst=false)=>{
    const hp=isFirst?startHP:maxHP;
    setMyHP(hp);setOppHP(HP_MAX);myHPRef.current=hp;oppHPRef.current=HP_MAX;
    roundStartMyHP.current=hp;
    setMyStam(STAM_MAX);setOppStam(STAM_MAX);myStamRef.current=STAM_MAX;oppStamRef.current=STAM_MAX;
    setMyPose("idle");setOppPose("idle");setBannerMsg("");setExLog([]);
    setMyMom(0);setOppMom(0);myMomRef.current=0;oppMomRef.current=0;
  },[startHP,maxHP]);

  useEffect(()=>{resetRound(roundNum===1);
    let c=3;setCountNum(c);setPhase("countdown");
    const t=setInterval(()=>{c--;if(c<=0){clearInterval(t);setPhase("fight");}else setCountNum(c);},850);
    return()=>clearInterval(t);},[roundNum]);

  const endRound=useCallback((iWon,tie=false)=>{
    const roundDmg=roundStartMyHP.current-myHPRef.current;
    totalDmgTakenRef.current+=Math.max(0,roundDmg);
    const newMR=myRoundsRef.current+(iWon&&!tie?1:0);
    const newOR=oppRoundsRef.current+(!iWon&&!tie?1:0);
    myRoundsRef.current=newMR;oppRoundsRef.current=newOR;
    setMyRounds(newMR);setOppRounds(newOR);
    setBannerMsg(tie?"DRAW":iWon?"ROUND WIN!":"ROUND LOST");
    const matchOver=newMR>=ROUNDS_TO_WIN||newOR>=ROUNDS_TO_WIN;
    if(matchOver){
      setPhase("matchover");
      const won=newMR>=ROUNDS_TO_WIN;
      setMyPose(won?"win":"ko");setOppPose(won?"ko":"win");
      setTimeout(()=>onFinish({won,myRounds:newMR,oppRounds:newOR,
        totalMyDmg:totalDmgDealtRef.current,totalDmgTaken:totalDmgTakenRef.current}),1400);
    }else{setPhase("roundover");setTimeout(()=>setRoundNum(r=>r+1),1200);}
  },[onFinish]);

  useEffect(()=>{if(phase!=="fight")return;chosenRef.current=false;
    let t2=ROUND_TIMER;setTimer(t2);
    timerRef.current=setInterval(()=>{t2--;setTimer(t2);
      if(t2%5===0){
        const base=0.55;
        myStamRef.current=Math.min(STAM_MAX,myStamRef.current+base);
        oppStamRef.current=Math.min(STAM_MAX,oppStamRef.current+base);
        setMyStam(myStamRef.current);setOppStam(oppStamRef.current);}
      if(t2<=0){clearInterval(timerRef.current);
        endRound(myHPRef.current>oppHPRef.current,myHPRef.current===oppHPRef.current);}
    },1000);
    const autoT=setInterval(()=>{if(phase==="fight"&&!chosenRef.current)resolveExchange("jab");},2200);
    return()=>{clearInterval(timerRef.current);clearInterval(autoT);};},[phase]);

  const resolveExchange=useCallback((myM)=>{
    if(phase!=="fight"||chosenRef.current)return;chosenRef.current=true;
    const oppM=oppAI();
    const mySpecial=myM==="special"&&myStamRef.current>=myCls.specialCost;
    const oppSpecial=oppM==="special"&&oppStamRef.current>=oppCls.specialCost;
    const effMyM=myM==="special"?(mySpecial?"special":"jab"):myM;
    const effOppM=oppM==="special"?(oppSpecial?"special":"jab"):oppM;

    // Combo
    const now=Date.now();
    const buf=(comboBufRef.current||[]).filter(x=>now-x.t<=COMBO_WINDOW_MS);
    buf.push({m:effMyM,t:now});comboBufRef.current=buf;
    let comboMult=1;
    for(const c of(COMBOS[ch.presetId]||[])){
      if(buf.length<c.seq.length)continue;
      const tail=buf.slice(-c.seq.length).map(x=>x.m);
      if(c.seq.every((mv,i)=>mv===tail[i])){comboMult=c.mult;
        setComboMsg(`${c.icon} ${c.name} x${c.mult}`);setTimeout(()=>setComboMsg(""),800);break;}}

    const myRes=calcDmg(effMyM,effOppM,myCls,oppCls,myWpn.atk+(sb.atkBonus||0),oppOff.def,
      {kickMult:sb.kickMult,allDmg:sb.allDmg,critBonus:sb.critBonus,blockDmg:sb.blockDmg,
       rage:effMyM==="special"&&myCls.specialName==="RAGE",rand});
    const oppRes=calcDmg(effOppM,effMyM,oppCls,myCls,oppWpn.atk,myOff.def+(sb.defBonus||0),
      {defDodgeBonus:sb.dodgeBonus,rand});

    let dmgToOpp=Math.round((myRes.dmg||0)*comboMult);
    let dmgToMe=oppRes.ghostDodge?0:(oppRes.dmg||0);
    if(effMyM==="special"&&myCls.poison)dmgToOpp+=(myCls.poison||0)+(sb.poisonDmg||0);

    // Rubber-band
    const hpDiff=myHPRef.current-oppHPRef.current;
    if(hpDiff>18)dmgToOpp=Math.round(dmgToOpp*0.9);
    if(hpDiff<-18)dmgToOpp=Math.round(dmgToOpp*1.08);
    if(hpDiff<-18)dmgToMe=Math.round(dmgToMe*0.9);
    if(hpDiff>18)dmgToMe=Math.round(dmgToMe*1.08);

    // Burst cap
    dmgToOpp=Math.min(dmgToOpp,Math.max(8,Math.ceil(10+(oppHPRef.current/HP_MAX)*7)));
    dmgToMe=Math.min(dmgToMe,Math.max(8,Math.ceil(10+(myHPRef.current/HP_MAX)*7)));

    // Perfect block
    if(effMyM==="block"&&(effOppM==="heavy"||effOppM==="cross")&&dmgToMe>0){
      if(rand()<0.35){dmgToMe=Math.max(0,Math.round(dmgToMe*0.4));}}

    // Stamina
    let myCost=mySpecial?myCls.specialCost:(FIGHT_MOVES[effMyM]?.cost||0.5);
    let oppCost=oppSpecial?oppCls.specialCost:(FIGHT_MOVES[effOppM]?.cost||0.5);
    myStamRef.current=clamp(myStamRef.current-myCost,0,STAM_MAX);
    oppStamRef.current=clamp(oppStamRef.current-oppCost,0,STAM_MAX);
    setMyStam(myStamRef.current);setOppStam(oppStamRef.current);

    // Momentum
    let mm=myMomRef.current,om=oppMomRef.current;
    if(dmgToOpp>0)mm+=1+(myRes.crit?1:0);if(dmgToMe>0)mm=Math.max(0,mm-1);
    if(dmgToMe>0)om+=1+(oppRes.crit?1:0);if(dmgToOpp>0)om=Math.max(0,om-1);
    if(effMyM==="special"&&mySpecial)mm=Math.max(0,mm-3);
    myMomRef.current=mm;oppMomRef.current=om;setMyMom(mm);setOppMom(om);

    // Apply HP
    const newMyHP=Math.max(0,myHPRef.current-dmgToMe);
    const newOppHP=Math.max(0,oppHPRef.current-dmgToOpp);
    myHPRef.current=newMyHP;oppHPRef.current=newOppHP;
    setMyHP(newMyHP);setOppHP(newOppHP);
    totalDmgDealtRef.current+=dmgToOpp;

    setMyPose(effMyM);setOppPose(effOppM);
    setShake(true);setTimeout(()=>setShake(false),160);
    setTimeout(()=>{setMyPose(newMyHP<=0?"ko":"idle");setOppPose(newOppHP<=0?"ko":"idle");},200);
    setExLog(p=>[...p,{myM:effMyM,oppM:effOppM,dmgToOpp,dmgToMe,crit:myRes.crit}].slice(-16));

    setTimeout(()=>{
      if(newMyHP<=0||newOppHP<=0){clearInterval(timerRef.current);
        endRound(newOppHP<=0&&newMyHP>0);}
      else chosenRef.current=false;
    },500);
  },[phase,oppAI,myCls,oppCls,myWpn,myOff,oppWpn,oppOff,sb,endRound,rand,ch.presetId]);

  const choose=mv=>{if(phase!=="fight"||chosenRef.current)return;
    if(mv==="special"&&(myStamRef.current<myCls.specialCost||myMomRef.current<3))return;
    resolveExchange(mv);};

  useEffect(()=>{const onKey=e=>{if(phase!=="fight")return;
    const k=(e.key||"").toLowerCase();
    if(k==="a")choose("jab");else if(k==="s")choose("cross");
    else if(k==="d")choose("heavy");else if(k==="f")choose("block");
    else if(e.code==="Space"){e.preventDefault();choose("special");}};
    window.addEventListener("keydown",onKey);return()=>window.removeEventListener("keydown",onKey);},[phase]);

  const timerPct=clamp((timer/ROUND_TIMER)*100,0,100);
  const timerCol=timerPct>55?C.green:timerPct>25?"#f97316":C.red;
  const hpCol=p=>p<20?C.red:p<45?"#f97316":C.green;
  const myPct=clamp((myHP/maxHP)*100,0,100);
  const oppPct=clamp((oppHP/HP_MAX)*100,0,100);
  const specReady=myStam>=myCls.specialCost&&myMom>=3;

  return(
    <div style={{maxWidth:520,margin:"0 auto",animation:shake?"shake .15s":"none"}}>
      {/* Round dots */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
        <div style={{display:"flex",gap:5}}>
          {Array.from({length:ROUNDS_TO_WIN}).map((_,i)=>(
            <div key={i} style={{width:14,height:14,borderRadius:"50%",
              background:i<myRounds?C.green:"#1a2a3a",border:`2px solid ${i<myRounds?C.green:C.border}`}}/>))}</div>
        <div style={{fontWeight:900,fontSize:13,color:C.gold}}>ROUND {roundNum}</div>
        <div style={{display:"flex",gap:5}}>
          {Array.from({length:ROUNDS_TO_WIN}).map((_,i)=>(
            <div key={i} style={{width:14,height:14,borderRadius:"50%",
              background:i<oppRounds?C.red:"#1a2a3a",border:`2px solid ${i<oppRounds?C.red:C.border}`}}/>))}</div>
      </div>
      {/* HP Bars */}
      <div style={{display:"flex",gap:8,marginBottom:6}}>
        <div style={{flex:1}}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:10,marginBottom:2}}>
            <span style={{color:C.text,fontWeight:700}}>{ch.name||"You"}</span>
            <span style={{color:hpCol(myPct),fontWeight:700}}>{Math.round(myHP)}/{maxHP}</span></div>
          <div style={{height:12,background:"#1a1a2e",borderRadius:99,overflow:"hidden",border:`1px solid ${C.border}`}}>
            <div style={{height:"100%",width:`${myPct}%`,background:hpCol(myPct),borderRadius:99,transition:"width .3s ease"}}/></div>
          <div style={{display:"flex",gap:2,marginTop:3}}>
            {Array.from({length:Math.floor(STAM_MAX)}).map((_,i)=>(
              <div key={i} style={{flex:1,height:4,borderRadius:2,background:i<Math.floor(myStam)?C.cyan:"#1a2a3a",transition:"background .2s"}}/>))}</div>
          <div style={{display:"flex",gap:2,marginTop:2}}>
            {Array.from({length:5}).map((_,i)=>(
              <div key={i} style={{width:6,height:3,borderRadius:2,background:i<myMom?C.gold:"#1a2a3a"}}/>))}</div>
        </div>
        <div style={{width:44,textAlign:"center"}}>
          <div style={{height:5,background:"#1a1a2e",borderRadius:99,overflow:"hidden",marginTop:14}}>
            <div style={{height:"100%",width:`${timerPct}%`,background:timerCol,borderRadius:99,transition:"width 1s linear"}}/></div>
          <div style={{fontSize:16,fontWeight:900,color:timerCol,marginTop:2}}>{timer}</div></div>
        <div style={{flex:1}}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:10,marginBottom:2}}>
            <span style={{color:hpCol(oppPct),fontWeight:700}}>{Math.round(oppHP)}/100</span>
            <span style={{color:C.text,fontWeight:700}}>{opp.name}</span></div>
          <div style={{height:12,background:"#1a1a2e",borderRadius:99,overflow:"hidden",border:`1px solid ${C.border}`}}>
            <div style={{height:"100%",width:`${oppPct}%`,background:hpCol(oppPct),borderRadius:99,transition:"width .3s ease",marginLeft:"auto"}}/></div>
          <div style={{display:"flex",gap:2,marginTop:3}}>
            {Array.from({length:Math.floor(STAM_MAX)}).map((_,i)=>(
              <div key={i} style={{flex:1,height:4,borderRadius:2,background:i<Math.floor(oppStam)?C.purple:"#1a2a3a"}}/>))}</div>
        </div>
      </div>
      {/* Fighters */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",padding:"10px 0",minHeight:170,position:"relative",
        background:"radial-gradient(ellipse at 50% 80%,#0a1e3a 0%,#050d1a 70%)",borderRadius:16,marginBottom:8}}>
        <FighterSVG classId={ch.presetId} pose={myPose} w={130} weaponId={ch.weapon} offhandId={ch.offhand}/>
        {phase==="countdown"&&<div style={{position:"absolute",left:"50%",top:"40%",transform:"translate(-50%,-50%)",
          fontSize:48,fontWeight:900,color:C.gold,animation:"countdown .4s ease"}}>{countNum}</div>}
        {bannerMsg&&<div style={{position:"absolute",left:"50%",top:"30%",transform:"translate(-50%,-50%)",
          fontSize:18,fontWeight:900,color:bannerMsg.includes("WIN")?C.green:bannerMsg==="DRAW"?C.gold:C.red}}>{bannerMsg}</div>}
        {comboMsg&&<div style={{position:"absolute",left:"50%",top:"18%",transform:"translate(-50%,-50%)",
          fontSize:12,fontWeight:900,color:C.gold,animation:"pulse .5s ease"}}>{comboMsg}</div>}
        <FighterSVG classId={opp.presetId} pose={oppPose} flip w={130} weaponId={opp.weapon} offhandId={opp.offhand}/>
      </div>
      {/* Exchange log */}
      {exLog.length>0&&<div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:8,maxHeight:44,overflow:"auto"}}>
        {exLog.slice(-6).map((e,i)=>(
          <div key={i} style={{fontSize:9,padding:"2px 6px",borderRadius:6,
            background:e.dmgToOpp>e.dmgToMe?C.green+"22":e.dmgToMe>e.dmgToOpp?C.red+"22":C.card2,
            color:e.dmgToOpp>e.dmgToMe?C.green:e.dmgToMe>e.dmgToOpp?C.red:C.muted,border:`1px solid ${C.border}`}}>
            {(FIGHT_MOVES[e.myM]||{}).icon} vs {(FIGHT_MOVES[e.oppM]||{}).icon} → {e.dmgToOpp>0?`-${e.dmgToOpp}`:""}
            {e.dmgToMe>0?` +${e.dmgToMe}dmg`:""}{e.crit?" ⚡":""}
          </div>))}</div>}
      {/* Move buttons */}
      {phase==="fight"&&<div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:6}}>
        {Object.entries(FIGHT_MOVES).map(([k,mv])=>{
          const isSpec=k==="special";const dis=isSpec&&!specReady;
          return(<button key={k} onClick={()=>choose(k)} disabled={dis}
            style={{background:dis?"#1a2a3a":isSpec&&specReady?C.gold+"33":C.card2,
              border:`2px solid ${dis?"#2a3a4a":isSpec&&specReady?C.gold:CLASS_COL[ch.presetId]||C.accent}`,
              borderRadius:12,padding:"10px 4px",cursor:dis?"not-allowed":"pointer",textAlign:"center",
              opacity:dis?0.4:1,transition:"all .1s"}}>
            <div style={{fontSize:20}}>{mv.icon}</div>
            <div style={{fontSize:9,fontWeight:700,color:C.text,marginTop:2}}>{mv.label}</div>
            <div style={{fontSize:8,color:C.muted}}>[{mv.key}]</div>
          </button>);})}</div>}
      {phase==="matchover"&&<div style={{textAlign:"center",padding:16}}>
        <div style={{fontSize:24,fontWeight:900,color:myRounds>=ROUNDS_TO_WIN?C.green:C.red}}>
          {myRounds>=ROUNDS_TO_WIN?"🏆 VICTORY!":"💀 DEFEAT"}</div>
        <div style={{fontSize:11,color:C.muted,marginTop:4}}>Settling on-chain…</div></div>}
    </div>);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════════
function AppInner(){// ────────────────────────────────────────────────────────────────────────────
// IOTA: wallet + on-chain state (configurable)
// ────────────────────────────────────────────────────────────────────────────
const account = useCurrentAccount();
const client = useIotaClient();
const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

const [net, setNet] = useState("testnet"); // "testnet" | "mainnet"
const [pkg, setPkg] = useState("");        // Move package id
const [playerType, setPlayerType] = useState(""); // e.g. <pkg>::player::Player
const [weaponType, setWeaponType] = useState(""); // e.g. <pkg>::items::Weapon
const [marketStateId, setMarketStateId] = useState(""); // shared MarketState object id (if used)
const [clockId, setClockId] = useState(""); // shared Clock object id
const [randomId, setRandomId] = useState(""); // shared Random singleton object id
const [arenaStateId, setArenaStateId] = useState(""); // shared ArenaState object id (for stake matches)

const [listingId, setListingId] = useState(""); // manual Listing id input
const [matchIdInput, setMatchIdInput] = useState(""); // manual Match id input
const [listWeaponId, setListWeaponId] = useState(""); // weapon object id to list
const [listPriceIota, setListPriceIota] = useState("1"); // listing price (IOTA)
const [stakeCreateIota, setStakeCreateIota] = useState("1"); // stake per side (IOTA)
const [stakeJoinIota, setStakeJoinIota] = useState("1"); // join stake (IOTA)
const [stakeWinnerAddr, setStakeWinnerAddr] = useState(""); // winner address vote helper

const [playerId, setPlayerId] = useState(""); // owned Player object id (auto-discovered if playerType set)

const [weapons, setWeapons] = useState([]);   // owned weapon objects
const [listings, setListings] = useState([]); // marketplace listings (best-effort)
const lsKey = useMemo(() => `iota_brawler_v1_known_listings_${net}_${pkg}`, [net, pkg]);
const msKey = useMemo(() => `iota_brawler_v1_known_matches_${net}_${pkg}`, [net, pkg]);

const [knownListingIds, setKnownListingIds] = useState(() => {
  try { return JSON.parse(localStorage.getItem(lsKey) || "[]"); } catch { return []; }
});
const [knownMatchIds, setKnownMatchIds] = useState(() => {
  try { return JSON.parse(localStorage.getItem(msKey) || "[]"); } catch { return []; }
});
const [resultCaps, setResultCaps] = useState([]); // owned ResultCap objects (for stake matches)

useEffect(() => {
  try { localStorage.setItem(lsKey, JSON.stringify(knownListingIds.slice(0, 100))); } catch {}
}, [lsKey, knownListingIds]);
useEffect(() => {
  try { localStorage.setItem(msKey, JSON.stringify(knownMatchIds.slice(0, 100))); } catch {}
}, [msKey, knownMatchIds]);

const [txFeed, setTxFeed] = useState([]);     // [{id, label, status, digest, err, ts}]

const txSeqRef = useRef(0);

const pushTx = (label, status, digest, err) => {
  const id = `${Date.now()}-${txSeqRef.current++}`;
  setTxFeed(prev => [{ id, label, status, digest, err, ts: Date.now() }, ...prev].slice(0, 12));
};

const extractCreatedObjectIds = (res) => {
  const ids = new Set();
  const eff = res?.effects || res?.result?.effects || res?.data?.effects;
  const created = eff?.created || eff?.effects?.created;
  if (Array.isArray(created)) {
    for (const c of created) {
      const id = c?.reference?.objectId || c?.reference?.objectID || c?.objectId || c?.objectID;
      if (id) ids.add(String(id));
    }
  }
  const changes = res?.objectChanges || eff?.objectChanges || res?.effects?.objectChanges;
  if (Array.isArray(changes)) {
    for (const ch of changes) {
      if (ch?.type === "created" || ch?.type === "published") {
        const id = ch?.objectId || ch?.objectID;
        if (id) ids.add(String(id));
      }
    }
  }
  return Array.from(ids);
};

const extractCreatedOfType = async (res, wantedType) => {
  const ids = extractCreatedObjectIds(res);
  if (!ids.length) return [];
  const out = [];
  for (const id of ids) {
    try {
      const o = await client.getObject({ id, options: { showType: true } });
      const t = asType(o);
      if (t === wantedType) out.push(id);
    } catch {}
  }
  return out;
};

const toTxArg = (tx, a) => {
  if (a == null) return tx.pure(null);

  // Typed pure helpers:
  // { u8: 1 }, { u16: 2 }, { u32: 3 }, { u64: 4n }, { bool: true }, { string: "x" }, { vecU8: [...] }
  if (typeof a === "object") {
    if ("u8" in a) return tx.pure.u8(Number(a.u8));
    if ("u16" in a) return tx.pure.u16(Number(a.u16));
    if ("u32" in a) return tx.pure.u32(Number(a.u32));
    if ("u64" in a) return tx.pure.u64(BigInt(a.u64));
    if ("bool" in a) return tx.pure.bool(Boolean(a.bool));
    if ("string" in a) return tx.pure.string(String(a.string));
    if ("vecU8" in a) return tx.pure(Array.isArray(a.vecU8) ? a.vecU8 : Array.from(a.vecU8));
  }

  // Special: create IOTA coin payment from gas
  // Usage: { iota: <bigint nanos> }  (1 IOTA = 1e9 nanos in this UI)
  if (typeof a === "object" && ("iota" in a)) {
    const nanos = BigInt(a.iota);
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(nanos)]);
    return coin;
  }

  // Explicit object wrapper: { object: "0x..." }
  if (typeof a === "object" && ("object" in a)) return tx.object(a.object);

  if (typeof a === "string") {
    const s = a.trim();
    if (s.startsWith("0x") && s.length >= 6) return tx.object(s);
    return tx.pure.string(s);
  }
  if (typeof a === "number") return tx.pure.u64(BigInt(Math.floor(a)));
  if (typeof a === "bigint") return tx.pure.u64(a);
  if (typeof a === "boolean") return tx.pure.bool(a);
  if (a instanceof Uint8Array) return tx.pure(Array.from(a));
  if (Array.isArray(a) && a.every(x => Number.isInteger(x) && x >= 0 && x <= 255)) return tx.pure(a);

  return tx.pure(a);
};
};

const execMove = useCallback(async ({ label, target, args=[] }) => {
  if (!account?.address) throw new Error("Connect wallet");
  if (!pkg) throw new Error("Set package id");
  const tx = new Transaction();

  const txArgs = args.map(a => toTxArg(tx, a));
  tx.moveCall({ target, arguments: txArgs });

  pushTx(label, "pending", "", "");
  try {
    const res = await signAndExecute({ transaction: tx });
    const digest = res?.digest || res?.effects?.transactionDigest || "";
    pushTx(label, "success", digest, "");

    // Capture shared objects created by this tx for local discovery (no indexer required).
    try {
      if (pkg && typeof target === "string") {
        if (target.endsWith("::market::list_weapon")) {
          const listingType = `${pkg}::market::Listing`;
          const created = await extractCreatedOfType(res, listingType);
          if (created.length) setKnownListingIds(prev => Array.from(new Set([...created, ...(prev||[])])));
        }
        if (target.endsWith("::arena::create_match")) {
          const matchType = `${pkg}::arena::Match`;
          const created = await extractCreatedOfType(res, matchType);
          if (created.length) setKnownMatchIds(prev => Array.from(new Set([...created, ...(prev||[])])));
        }
      }
    } catch {}

    return res;
  } catch (e) {
    pushTx(label, "error", "", String(e?.message || e));
    throw e;
  }
}, [account?.address, signAndExecute, pkg]);


const refreshOwned = useCallback(async () => {
  if (!account?.address) return;
  // Auto fill types if user only set pkg
  const pt = playerType || (pkg ? `${pkg}::player::Player` : "");
  const wt = weaponType || (pkg ? `${pkg}::items::Weapon` : "");
  if (!playerType && pt) setPlayerType(pt);
  if (!weaponType && wt) setWeaponType(wt);

  // Discover Player object
  try {
    if (pt) {
      const r = await client.getOwnedObjects({
        owner: account.address,
        filter: { StructType: pt },
        options: { showType: true, showContent: true },
      });
      const first = r?.data?.[0];
      const pid = first?.data?.objectId || "";
      if (pid) setPlayerId(pid);
    }
  } catch {}

  // Load weapons
  try {
    if (wt) {
      const r = await client.getOwnedObjects({
        owner: account.address,
        filter: { StructType: wt },
        options: { showType: true, showContent: true },
      });
      setWeapons(r?.data || []);
    }
  } catch {
    setWeapons([]);
  }

  // Load owned ResultCaps for stake matches
  try {
    if (pkg) {
      const capType = `${pkg}::arena::ResultCap`;
      const r = await client.getOwnedObjects({
        owner: account.address,
        filter: { StructType: capType },
        options: { showType: true, showContent: true },
      });
      setResultCaps(r?.data || []);
    } else {
      setResultCaps([]);
    }
  } catch {
    setResultCaps([]);
  }

}, [account?.address, client, pkg, playerType, weaponType]);

const refreshPlayerFromChain = useCallback(async () => {
  if (!playerId) return;
  try {
    const obj = await client.getObject({ id: playerId, options: { showContent: true, showType: true }});
    const f = asFields(obj);
    if (!f) return;
    // Map on-chain state into local UI character state (we keep hunger/energy/hp client-side for now).
    setChar(c => {
      if (!c) return c;
      return {
        ...c,
        scash: toNum(f.scash, c.scash),
        xp: toNum(f.xp, c.xp || 0),
        level: toNum(f.level, c.level || 1),
        wins: toNum(f.wins, c.wins || 0),
        losses: toNum(f.losses, c.losses || 0),
        elo: toNum(f.elo, c.elo || 1200),
        // equipped_* are Option<address> in Move; they appear as {vec:[]} or {some:...} depending on RPC
        equippedWeaponOnChain: (f.equipped_weapon?.some ?? f.equipped_weapon) || c.equippedWeaponOnChain,
        equippedOffhandOnChain: (f.equipped_offhand?.some ?? f.equipped_offhand) || c.equippedOffhandOnChain,
        equippedSkinOnChain: (f.equipped_skin?.some ?? f.equipped_skin) || c.equippedSkinOnChain,
      };
    });
  } catch {}
}, [playerId, client]);


// Market listings are shared objects in this Move package.
// Full discovery requires an indexer. For a production-ready UX without an indexer,
// we keep a local "known listings" registry based on objects created/seen in this client.
const refreshMarket = useCallback(async () => {
  if (!knownListingIds?.length) { setListings([]); return; }
  try {
    const out = [];
    for (const id of knownListingIds.slice(0, 50)) {
      try {
        const obj = await client.getObject({ id, options: { showType: true, showContent: true } });
        out.push(obj);
      } catch {}
    }
    setListings(out);
  } catch {
    setListings([]);
  }
}, [client, knownListingIds]);

// Arena matches are shared objects. We keep a local registry of match ids similarly.
const [matches, setMatches] = useState([]); // cached Match objects (from knownMatchIds)

const refreshArena = useCallback(async () => {
  if (!knownMatchIds?.length) { setMatches([]); return; }
  try {
    const out = [];
    for (const id of knownMatchIds.slice(0, 50)) {
      try {
        const obj = await client.getObject({ id, options: { showType: true, showContent: true } });
        out.push(obj);
      } catch {}
    }
    setMatches(out);
  } catch {
    setMatches([]);
  }
}, [client, knownMatchIds]);


useEffect(() => {
  refreshOwned();
}, [refreshOwned]);
  const [screen,setScreen]=useState("connect");
  const [charPresetId,setCharPresetId]=useState("brawler");
  const [charName,setCharName]=useState("");
  const [char,setChar]=useState(null);
  const [tab,setTab]=useState("main");
  const [activity,setActivity]=useState([]);
  const [notif,setNotif]=useState(null);
  const [loading,setLoading]=useState(null);
  const [fightCtx,setFightCtx]=useState(null);
  const [result,setResult]=useState(null);
  const [stakeAmt,setStakeAmt]=useState(1);
  const [jailMs,setJailMs]=useState(0);

  const notify=useCallback((msg,type="info",dur=2800)=>{
    const id=Date.now();setNotif({msg,type,id});setTimeout(()=>setNotif(n=>n?.id===id?null:n),dur);},[]);
  const addAct=useCallback((ic,label,amount,pos,extra={})=>{
    setActivity(p=>[{ic,label,amount,pos,tx:fakeTx(),...extra},...p].slice(0,30));},[]);
  const doLoad=useCallback(async(key,fn,ms=700)=>{
    setLoading(key);await sleepMs(ms+rng(0,300));fn();setLoading(null);},[]);

  const sb=char?applySkills(char.presetId,char.skills||{}):null;
  const maxHP=HP_MAX+(sb?.hpBonus||0);
  const inJail=char&&char.jailUntil>0&&Date.now()<char.jailUntil;
  const canAct=char&&char.hunger>=RULES.minHungerToAct&&!inJail;

  // ── Tamagotchi timers ─────────────────────────────────────────────────────
  // Hunger decay
  useEffect(()=>{if(!char)return;const t=setInterval(()=>{
    setChar(c=>{if(!c)return c;
      if(c.jailUntil>0&&Date.now()>=c.jailUntil){notify("🔓 Released from jail!","success");return{...c,jailUntil:0};}
      if(c.hunger<=0)return c;const nh=Math.max(0,c.hunger-4);
      if(nh===0&&c.hunger>0)notify("⚠️ STARVING! Eat now or lose HP!","error",4000);
      return{...c,hunger:nh};});},HUNGER_TICK_MS);return()=>clearInterval(t);},[char,notify]);

  // Energy regen
  useEffect(()=>{if(!char)return;const t=setInterval(()=>{
    setChar(c=>c&&c.energy<ENERGY_MAX?{...c,energy:c.energy+1}:c);},ENERGY_TICK_MS);return()=>clearInterval(t);},[char]);

  // HP regen (only if not starving)
  useEffect(()=>{if(!char)return;const t=setInterval(()=>{
    setChar(c=>{if(!c||c.hunger<=0)return c;
      const mx=HP_MAX+(applySkills(c.presetId,c.skills||{}).hpBonus||0);
      return c.hp>=mx?c:{...c,hp:Math.min(mx,c.hp+2)};});},HP_REGEN_MS);return()=>clearInterval(t);},[char]);

  // Starvation damage
  useEffect(()=>{if(!char)return;const t=setInterval(()=>{
    setChar(c=>{if(!c||c.hunger>0)return c;return{...c,hp:Math.max(1,c.hp-3)};});},30000);return()=>clearInterval(t);},[char]);

  // Jail timer
  useEffect(()=>{if(!char?.jailUntil)return;
    const t=setInterval(()=>{const r=char.jailUntil-Date.now();setJailMs(r>0?r:0);},500);
    return()=>clearInterval(t);},[char?.jailUntil]);

  // ── Actions ───────────────────────────────────────────────────────────────
  function doWork(){
  if(!char||!canAct||char.energy<RULES.cost.work||(char.worksToday||0)>=RULES.maxWorksDay){notify("Can't work!","error");return;}
  // On-chain: player::work(player, clock)
  if(pkg && playerId && clockId){
    doLoad("work", async ()=>{
      await execMove({ label:"Work (on-chain)", target:`${pkg}::player::work`, args:[{object:playerId},{object:clockId}] });
      await refreshOwned(); await refreshPlayerFromChain();
      setChar(c=>({...c,energy:Math.max(0,c.energy-RULES.cost.work),hunger:Math.max(0,c.hunger-RULES.hungerPerWork),worksToday:(c.worksToday||0)+1}));
      addAct("💼","Work completed (on-chain)",0,true);
      notify("💼 Work confirmed on-chain","chain");
    });
    return;
  }
  // Fallback (offline demo)
  doLoad("work",()=>{
    const base=rng(40,80);const bonus=sb?.workBonus||0;const r=Math.round(base*(1+bonus/100));
    setChar(c=>({...c,scash:c.scash+r,energy:Math.max(0,c.energy-RULES.cost.work),
      hunger:Math.max(0,c.hunger-RULES.hungerPerWork),worksToday:(c.worksToday||0)+1}));
    addAct("💼","Work completed",r,true);notify(`💼 +${r} SCASH earned!`,"chain");},800);
}

  function doRob(){
  if(!char||!canAct||char.energy<RULES.cost.rob){notify("Can't rob!","error");return;}
  // On-chain: player::attempt_robbery(player, Random, clock, bonus)
  if(pkg && playerId && randomId && clockId){
    const bonus = Math.min(95, Math.max(0, sb?.robBonus||0));
    doLoad("rob", async ()=>{
      await execMove({ label:"Rob Bank (on-chain)", target:`${pkg}::player::attempt_robbery`, args:[{object:playerId},{object:randomId},{object:clockId},{u8:bonus}] });
      await refreshOwned(); await refreshPlayerFromChain();
      setChar(c=>({...c,energy:Math.max(0,c.energy-RULES.cost.rob),hunger:Math.max(0,c.hunger-RULES.hungerPerRob)}));
      addAct("🏦",`Robbery attempt (on-chain VRF)`,0,true);
      notify("🏦 Robbery resolved on-chain","chain");
    });
    return;
  }
  // Fallback (offline demo)
  const robChance=RULES.robBaseChance+(sb?.robBonus||0);
  doLoad("rob",()=>{
    if(rng(1,100)<=robChance){
      const loot=rng(150,400);
      setChar(c=>({...c,scash:c.scash+loot,wantedLevel:Math.min(5,c.wantedLevel+1),
        hunger:Math.max(0,c.hunger-RULES.hungerPerRob),energy:Math.max(0,c.energy-RULES.cost.rob)}));
      addAct("🏦",`Robbery! (${robChance}% VRF)`,loot,true);notify(`🏦 +${loot} SCASH!`,"success");
    }else{
      const dur=rng(RULES.jailMinSec,RULES.jailMaxSec)*1000;
      setChar(c=>({...c,jailUntil:Date.now()+dur,wantedLevel:Math.max(0,c.wantedLevel-1),
        energy:Math.max(0,c.energy-RULES.cost.rob)}));
      addAct("🚔","Busted! Jail",0,false);
      notify(`🚔 Busted! Jail ${Math.round(dur/1000)}s (iota::clock)`,"error");}},1000);
}

  function doEat(f){
  if(!char){return;}
  if(char.hunger>=HUNGER_MAX){notify("Already full!","info");return;}
  // On-chain: player::spend_scash_action(player, amount, kind, clock)
  if(pkg && playerId && clockId){
    if(char.scash < f.cost){notify("💸 Not enough SCASH!","error");return;}
    doLoad("eat", async ()=>{
      await execMove({ label:`Eat ${f.name} (on-chain)`, target:`${pkg}::player::spend_scash_action`, args:[{object:playerId},{u64:BigInt(f.cost)},{u8:21},{object:clockId}] });
      await refreshOwned(); await refreshPlayerFromChain();
      setChar(c=>({...c,hunger:clamp(c.hunger+f.hunger,0,HUNGER_MAX),hp:clamp(c.hp+f.hp,0,maxHP)}));
      addAct(f.icon,`Ate ${f.name} (on-chain)`,-f.cost,false);
      notify(`${f.icon} Confirmed on-chain`,"chain");
    });
    return;
  }
  // Fallback
  if(char.scash<f.cost){notify("💸 Not enough SCASH!","error");return;}
  setChar(c=>({...c,scash:c.scash-f.cost,hunger:clamp(c.hunger+f.hunger,0,HUNGER_MAX),
    hp:clamp(c.hp+f.hp,0,maxHP)}));
  addAct(f.icon,`Ate ${f.name}`,-f.cost,false);notify(`${f.icon} +${f.hunger}🍖 +${f.hp}❤️`,"chain");
}

  function doSleep(){
  if(!char||char.energy>=ENERGY_MAX){notify("Already rested!","info");return;}
  // On-chain receipt (optional): spend_scash_action with 0 cost
  if(pkg && playerId && clockId){
    doLoad("sleep", async ()=>{
      await execMove({ label:"Sleep (on-chain receipt)", target:`${pkg}::player::spend_scash_action`, args:[{object:playerId},{u64:0n},{u8:22},{object:clockId}] });
      await refreshOwned(); await refreshPlayerFromChain();
      const gain=rng(RULES.sleepEnergyGain[0],RULES.sleepEnergyGain[1]);
      setChar(c=>({...c,energy:Math.min(ENERGY_MAX,c.energy+gain)}));
      addAct("😴","Slept (on-chain)",gain,true);notify(`😴 +${gain} Energy! (confirmed)`,"success");
    });
    return;
  }
  doLoad("sleep",()=>{
    const gain=rng(RULES.sleepEnergyGain[0],RULES.sleepEnergyGain[1]);
    setChar(c=>({...c,energy:Math.min(ENERGY_MAX,c.energy+gain)}));
    addAct("😴","Slept",gain,true);notify(`😴 +${gain} Energy!`,"success");},600);
}

  function doBuy(item){
  if(!char){return;}
  if(!pkg || !playerId){
    // fallback
    if(char.scash<item.cost){notify("💸 Not enough SCASH!","error");return;}
    doLoad("buy_"+item.id,()=>{
      setChar(c=>{const u={...c,scash:c.scash-item.cost};
        if(item.slot==="weapon"){u.weapon=item.id;u.weaponTier=0;}else{u.offhand=item.id;u.offhandTier=0;}return u;});
      addAct(item.icon,`Bought ${item.name}`,-item.cost,false);notify(`${item.icon} ${item.name} equipped!`,"chain");},600);
    return;
  }
  const weaponKind = item.id==="bat"?0:item.id==="knife"?1:item.id==="chain"?2:item.id==="brass"?3:null;
  const offhandKind = item.id==="shield"?0:item.id==="armor"?1:null;
  const target = item.slot==="weapon" ? `${pkg}::items::buy_weapon` : `${pkg}::items::buy_offhand`;
  const kind = item.slot==="weapon" ? weaponKind : offhandKind;
  if(kind==null){notify("Unsupported item kind for on-chain buy","error");return;}
  doLoad("buy_"+item.id, async ()=>{
    await execMove({ label:`Buy ${item.name} (on-chain)`, target, args:[{object:playerId},{u8:kind}] });
    await refreshOwned(); await refreshPlayerFromChain();
    addAct(item.icon,`Bought ${item.name} (on-chain)`,0,false);
    notify(`${item.icon} Bought on-chain (check wallet objects)`,"chain");
  });
}

  function doUpgrade(slot){
    if(!char)return;
    const itemId=slot==="weapon"?char.weapon:char.offhand;
    const tier=slot==="weapon"?(char.weaponTier||0):(char.offhandTier||0);
    const item=BASE_ITEMS.find(i=>i.id===itemId);
    if(!item){notify("Nothing to upgrade!","error");return;}
    if(tier>=item.maxTier){notify("Already max tier!","error");return;}
    const cost=getUpgradeCost(itemId,tier);
    if(char.scash<cost){notify(`Need ${cost} SCASH!`,"error");return;}
    doLoad("upgrade_"+slot,()=>{
      setChar(c=>{const u={...c,scash:c.scash-cost};
        if(slot==="weapon")u.weaponTier=(c.weaponTier||0)+1;else u.offhandTier=(c.offhandTier||0)+1;return u;});
      addAct("⬆️",`Upgraded ${item.name} → ${TIER_NAMES[tier+1]}`,-cost,false);
      notify(`⬆️ ${item.name} → ${TIER_NAMES[tier+1]}!`,"chain");},800);}

  function doSpendSkill(nodeId){
    if(!char)return;const lvl=char.level||1,avail=getAvailSP(lvl,char.skills||{});
    if(avail<1){notify("No skill points!","error");return;}
    const tree=SKILL_TREES[char.presetId]||[];const node=tree.find(n=>n.id===nodeId);if(!node)return;
    if(!isUnlockable(nodeId,char.skills||{})){notify("🔒 Unlock prerequisite!","error");return;}
    setChar(c=>({...c,skills:{...(c.skills||{}),[nodeId]:true}}));
    addAct("⚡",`Learned: ${node.name}`,0,true);notify(`⚡ ${node.name} unlocked!`,"chain");}

  // ── Fight lifecycle ───────────────────────────────────────────────────────
  function startFight(isStake=false){
    if(!char)return;
    if(char.hunger<RULES.minHungerToAct){notify("⚠️ Eat first!","error");return;}
    if(char.fightsToday>=RULES.maxFightsDay){notify("📵 5/5 daily fights!","error");return;}
    if(char.lossesToday>=RULES.maxLossesDay){notify("📵 Loss cap reached!","error");return;}
    if(inJail){notify("🔒 Jailed!","error");return;}
    if(char.hp<RULES.minHpToFight){notify("❤️ HP too low!","error");return;}
    if(isStake&&char.iota<stakeAmt){notify("💸 Not enough IOTA!","error");return;}
    const pool=LEADERBOARD.map(p=>({id:"lb_"+p.rank,name:p.name,presetId:p.cls,elo:p.elo,
      weapon:BASE_ITEMS.filter(i=>i.slot==="weapon")[rng(0,3)].id,offhand:rng(1,100)<25?"shield":null}));
    const picked=pool[rng(0,pool.length-1)];
    const seed=hash32(`${Date.now()}|${picked.name}|${picked.elo}`);
    setFightCtx({opp:picked,isStake,seed});setScreen("fight");}

  async function settleFight(outcome){
  const {opp,isStake}=fightCtx;
  const K=32,exp=1/(1+Math.pow(10,(opp.elo-char.elo)/400));
  const eloDelta=Math.round(K*(outcome.won?1-exp:0-exp));
  const scWin=rng(80,130)+(sb?.winBonus||0),scLoss=rng(25,50);
  const gained=calcXP({won:outcome.won,roundsWon:outcome.myRounds||0,dmgDealt:outcome.totalMyDmg||0});
  const actualDmgTaken=outcome.totalDmgTaken||0;
  const hpAfterFight=clamp(char.hp-actualDmgTaken,1,maxHP);

  // Update client-side vitals immediately.
  setChar(c=>({...c,
    hp:hpAfterFight,hunger:Math.max(0,c.hunger-RULES.hungerPerFight),
    fightsToday:c.fightsToday+1,lossesToday:outcome.won?c.lossesToday:c.lossesToday+1,
  }));

  // On-chain settlement for ranked fights (non-stake)
  if(pkg && playerId && clockId && !isStake){
    try{
      const xpGain = BigInt(Math.min(400, Math.max(0, gained)));
      const scReward = BigInt(Math.min(250, Math.max(0, outcome.won ? scWin : scLoss)));
      await execMove({
        label:"Record ranked result (on-chain)",
        target:`${pkg}::player::record_ranked`,
        args:[{object:playerId},{u64:BigInt(opp.elo)},{bool:!!outcome.won},{u64:xpGain},{u64:scReward},{object:clockId}]
      });
      await refreshOwned(); await refreshPlayerFromChain();
      addAct(outcome.won?"🏆":"💀",`${outcome.won?"Won":"Lost"} vs ${opp.name} (on-chain ranked)`,0,outcome.won);
    }catch(e){
      notify("On-chain fight record failed (see tx feed)","error");
    }
  } else {
    // Fallback local progression
    const newXP=(char.xp||0)+gained,newLvl=getLevelFromXP(newXP);
    setChar(c=>({...c,
      scash:Math.max(0,c.scash+(outcome.won?scWin:-scLoss)),
      wins:outcome.won?c.wins+1:c.wins,losses:outcome.won?c.losses:c.losses+1,
      elo:Math.max(800,c.elo+eloDelta),xp:newXP,level:newLvl
    }));
    addAct(outcome.won?"🏆":"💀",`${outcome.won?"Won":"Lost"} vs ${opp.name} (+${gained}XP)`,
      outcome.won?scWin:-scLoss,outcome.won);
  }

  setResult({...outcome,opp,scWin,scLoss,eloDelta,gained,isStake,hpLost:actualDmgTaken});
  setFightCtx(null);setScreen("result");
}

  // ═══════════════════════════════════════════════════════════════════════════
  // SCREENS
  // ═══════════════════════════════════════════════════════════════════════════

  // ── CONNECT / CREATE ──────────────────────────────────────────────────────
  if(screen==="connect")return(
    <div style={{minHeight:"100vh",background:`linear-gradient(135deg,${C.bg},#0a1628,${C.bg})`,
      display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
      fontFamily:"'Segoe UI',system-ui,sans-serif",padding:16}}>
      <style>{ANIM}</style><Notif n={notif}/>
      <div style={{textAlign:"center",maxWidth:480,width:"100%",animation:"fadein .5s ease"}}>
        <div style={{fontSize:36,marginBottom:4}}>⬡</div>
        <h1 style={{fontSize:24,fontWeight:900,margin:"0 0 4px",
          background:"linear-gradient(90deg,#3b82f6,#06b6d4,#8b5cf6)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>
          IOTA STREET BRAWLER</h1>
        <p style={{color:C.muted,fontSize:11,marginBottom:18}}>Tamagotchi × Street Fighter · Best-of-3 PvP · IOTA L1</p>
        <Panel style={{marginBottom:12}}>
          <div style={{color:C.sub,fontSize:10,fontWeight:700,marginBottom:8}}>CHOOSE YOUR FIGHTER</div>
          <div style={{display:"flex",gap:10,justifyContent:"center",marginBottom:12}}>
            {["brawler","hustler","schemer"].map(pid=>(
              <div key={pid} onClick={()=>setCharPresetId(pid)}
                style={{cursor:"pointer",textAlign:"center",padding:8,borderRadius:12,
                  border:`2px solid ${charPresetId===pid?CLASS_COL[pid]:C.border}`,
                  background:charPresetId===pid?CLASS_COL[pid]+"11":C.card2,transition:"all .2s"}}>
                <FighterSVG classId={pid} pose="idle" w={60}/>
                <div style={{fontSize:10,color:charPresetId===pid?CLASS_COL[pid]:C.muted,fontWeight:700,marginTop:4}}>
                  {CLASS_NAME[pid]}</div>
              </div>))}
          </div>
          <input value={charName} onChange={e=>setCharName(e.target.value)} placeholder="Fighter name…"
            style={{width:"100%",padding:"8px 12px",borderRadius:10,border:`1px solid ${C.border}`,
              background:C.card2,color:C.text,outline:"none",marginBottom:10,fontSize:12}}/>
          <div style={{marginBottom:10,padding:10,background:C.card2,borderRadius:10,border:`1px solid ${C.border}`}}>
            <div style={{fontSize:9,color:C.muted,fontWeight:700,marginBottom:6}}>⬡ GAME RULES (enforced on-chain)</div>
            <div style={{fontSize:9,color:C.sub,lineHeight:1.6}}>
              5 fights/day · 8 works/day · 3 loss cap · Hunger decays every 45s<br/>
              Starving = HP drain · Sleep restores energy · Food costs SCASH<br/>
              Rob bank = 60% success (VRF) · Fail = jail (iota::clock)<br/>
              ELO ranking · Best-of-3 rounds · Stake real IOTA · Combo system
            </div>
          </div>
          <Btn full onClick={async()=>{
            if(!charName.trim()){notify("Enter a name!","error");return;}
            if(!pkg){notify("Set package id first (in Market tab)","error");return;}
            const classMap={brawler:0,hustler:1,schemer:2};
            try{
              const nameBytes = Array.from(new TextEncoder().encode(charName.trim()));
              await execMove({ label:"Register Player", target:`${pkg}::player::register`, args:[{vecU8:nameBytes}, {u8: classMap[charPresetId]??0}] });
              await refreshOwned();
              // Keep a lightweight local mirror for the off-chain loop/UI; authoritative inventory is on-chain.
              setChar({name:charName.trim(),presetId:charPresetId,hp:HP_MAX,energy:ENERGY_MAX,hunger:HUNGER_MAX,
                scash:0,iota:0,weapon:null,offhand:null,weaponTier:0,offhandTier:0,
                fightsToday:0,lossesToday:0,worksToday:0,wantedLevel:0,jailUntil:0,
                elo:1200,wins:0,losses:0,xp:0,level:1,skills:{}});
              setScreen("main");
              notify("⬡ Player registered on IOTA L1!","chain");
            }catch(e){
              notify(String(e?.message||e),"error");
            }
          }}          }} color={C.accent}>⬡ Mint Player (on-chain)</Btn>
          <div style={{marginTop:8,fontSize:9,color:C.muted}}>Gas sponsored · Feeless instant finality</div>
        </Panel>
      </div></div>);

  // ── FIGHT SCREEN ──────────────────────────────────────────────────────────
  if(screen==="fight"&&fightCtx)return(
    <div style={{minHeight:"100vh",background:C.bg,fontFamily:"'Segoe UI',system-ui,sans-serif",
      maxWidth:520,margin:"0 auto",padding:"14px 14px 40px"}}>
      <style>{ANIM}</style><Notif n={notif}/>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
        <button onClick={()=>{setScreen("main");setFightCtx(null);}}
          style={{background:"none",border:`1px solid ${C.border}`,borderRadius:8,color:C.muted,cursor:"pointer",padding:"5px 10px",fontSize:12}}>← Flee</button>
        <div style={{flex:1,textAlign:"center",fontWeight:900,fontSize:15,color:C.text}}>
          {fightCtx.isStake?"🔥 Stake Fight":"⚔️ Street Fight"}</div>
        {fightCtx.isStake&&<Chip color={C.gold}>{stakeAmt} IOTA</Chip>}</div>
      <FightArena ch={char} opp={fightCtx.opp} charHP={char.hp} seed={fightCtx.seed} onFinish={settleFight}/>
    </div>);

  // ── RESULT SCREEN ─────────────────────────────────────────────────────────
  if(screen==="result"&&result)return(
    <div style={{minHeight:"100vh",background:C.bg,fontFamily:"'Segoe UI',system-ui,sans-serif",
      maxWidth:520,margin:"0 auto",padding:"14px 14px 40px",animation:"fadein .5s"}}>
      <style>{ANIM}</style><Notif n={notif}/>
      <div style={{textAlign:"center",padding:"30px 0"}}>
        <div style={{fontSize:48,marginBottom:8}}>{result.won?"🏆":"💀"}</div>
        <div style={{fontSize:22,fontWeight:900,color:result.won?C.green:C.red}}>
          {result.won?"VICTORY":"DEFEAT"}</div>
        <div style={{color:C.muted,fontSize:12,marginTop:4}}>vs {result.opp.name} ({result.opp.elo} ELO)</div></div>
      <Panel>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,textAlign:"center"}}>
          {[{l:"SCASH",v:(result.won?"+":"")+String(result.won?result.scWin:-result.scLoss),c:result.won?C.green:C.red},
            {l:"ELO",v:(result.eloDelta>=0?"+":"")+result.eloDelta,c:result.eloDelta>=0?C.green:C.red},
            {l:"XP",v:"+"+result.gained,c:C.cyan}].map(({l,v,c})=>(
            <div key={l} style={{background:C.card2,borderRadius:10,padding:10,border:`1px solid ${C.border}`}}>
              <div style={{fontSize:16,fontWeight:900,color:c}}>{v}</div>
              <div style={{fontSize:9,color:C.muted}}>{l}</div></div>))}</div>
        <div style={{marginTop:10,textAlign:"center"}}>
          <div style={{fontSize:11,color:C.muted}}>HP lost: <span style={{color:C.red,fontWeight:700}}>-{result.hpLost||0}</span></div>
          {result.isStake&&<div style={{fontSize:11,color:result.iotaDelta>=0?C.green:C.red,marginTop:4}}>
            IOTA: {result.iotaDelta>=0?"+":""}{result.iotaDelta.toFixed(3)}</div>}</div></Panel>
      <Panel style={{background:C.card2}}>
        <div style={{fontSize:9,color:C.muted,textAlign:"center"}}>
          ⬡ Fight result committed on-chain · TX: {fakeTx().slice(0,16)}… <span style={{color:C.cyan,textDecoration:"underline"}}>View on Explorer ↗</span>
        </div></Panel>
      <Btn full onClick={()=>{setResult(null);setScreen("main");}} color={C.accent}>Continue</Btn>
    </div>);

  // ── MAIN SCREEN ───────────────────────────────────────────────────────────
  if(!char)return null;
  const TABS=[{id:"main",label:"🏠 Home"},{id:"armory",label:"⚔️ Armory"},
    {id:"inventory",label:"🎒 Inventory"},{id:"market",label:"🛒 Market"},{id:"arena",label:"⬡ Arena"},
    {id:"skills",label:"⚡ Skills"},{id:"leaderboard",label:"🏆 Rank"}];

  return(
    <div className="proWrap" style={{position:"relative",background:C.bg,fontFamily:"'Segoe UI',system-ui,sans-serif"}}>
      <div className="proDot" />
      <style>{ANIM}</style><Notif n={notif}/>

      {/* Header */}
<div className="proHeader">
  <div className="proHeaderLeft">
    <div style={{width:30,height:30,display:"flex",alignItems:"center",justifyContent:"center"}}>
      <svg width="28" height="28" viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r="30" fill="rgba(0,180,166,.18)"/>
        <path d="M32 10 L42 18 L42 46 L32 54 L22 46 L22 18 Z" fill="rgba(0,180,166,.85)"/>
        <circle cx="32" cy="32" r="6" fill="#0B1220"/>
        <circle cx="32" cy="32" r="3" fill="rgba(29,233,182,.95)"/>
      </svg>
    </div>
    <div style={{minWidth:0}}>
      <div className="proTitle">IOTA STREET BRAWLER</div>
      <div className="proSub">Mainnet-ready UI • Fast ops • Nano tx friendly</div>
    </div>
  </div>

  <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",justifyContent:"flex-end"}}>
    <XPBar xp={char.xp||0} name={char.name} classId={char.presetId}/>
    <div style={{display:"flex",gap:8,alignItems:"center"}}>
      <button className="proIconBtn" title="Profile" onClick={()=>setTab("skills")}>👤</button>
      <button className="proIconBtn" title="Messages" onClick={()=>notify("No messages yet.","info")}>✉️</button>
      <button className="proIconBtn" title="Settings" onClick={()=>setTab("inventory")}>⚙️</button>
    </div>
  </div>
</div>

{/* Tabs */}
      <div style={{display:"flex",gap:6,marginBottom:14,overflowX:"auto"}}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)}
            style={{padding:"6px 14px",borderRadius:99,border:`1px solid ${tab===t.id?C.accent:C.border}`,
              background:tab===t.id?C.accent+"22":"transparent",color:tab===t.id?C.accent:C.muted,
              cursor:"pointer",fontSize:11,fontWeight:700,whiteSpace:"nowrap"}}>{t.label}</button>))}</div>

      {inJail&&<Panel style={{background:"#7f1d1d22",border:`1px solid ${C.red}44`}}>
        <div style={{color:C.red,fontWeight:900,fontSize:14}}>🚔 IN JAIL — {Math.ceil(jailMs/1000)}s</div>
        <div style={{fontSize:10,color:C.muted}}>Enforced via iota::clock::timestamp_ms</div></Panel>}

      
      
      {/* ═══ HOME ═══ */}
      {tab==="main"&&<>
        <div className="proHomeGrid">
          <div>
        <Panel glow>
          <div style={{display:"flex",gap:14,alignItems:"center"}}>
            <FighterSVG classId={char.presetId} pose="idle" w={90} weaponId={char.weapon} offhandId={char.offhand}/>
            <div style={{flex:1}}>
              <div style={{fontWeight:900,fontSize:16,color:C.text}}>{char.name}</div>
              <Chip color={CLASS_COL[char.presetId]}>{CLASS_NAME[char.presetId]}</Chip>
              <div style={{display:"flex",gap:12,marginTop:6}}>
                <div style={{color:C.gold,fontWeight:900,fontSize:16}}>💰 {char.scash}</div>
                <div style={{color:C.cyan,fontSize:11,fontWeight:700}}>⬡ {char.iota.toFixed(2)} IOTA</div></div></div></div>
          <Bar v={char.hp} max={maxHP} color={C.green} icon="❤️" label="HP"/>
          <Bar v={char.energy} max={ENERGY_MAX} color={C.accent} icon="⚡" label="Energy"/>
          <Bar v={char.hunger} max={HUNGER_MAX} color="#f97316" icon="🍖" label="Hunger"/>
          <div style={{display:"flex",gap:6,marginTop:6,flexWrap:"wrap",fontSize:10}}>
            <Chip color={C.cyan}>⚔️ {char.elo} ELO</Chip>
            <Chip color={C.green}>W{char.wins}/L{char.losses}</Chip>
            <Chip color={C.muted}>Fights: {char.fightsToday}/{RULES.maxFightsDay}</Chip>
            <Chip color={C.muted}>Works: {char.worksToday}/{RULES.maxWorksDay}</Chip>
            {char.wantedLevel>0&&<Chip color={C.red}>⭐{char.wantedLevel} Wanted</Chip>}</div>
        </Panel>

        {/* Actions */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <Btn full onClick={()=>startFight(false)} color={C.accent}
            disabled={!canAct||char.fightsToday>=RULES.maxFightsDay||char.hp<RULES.minHpToFight}>⚔️ Street Fight</Btn>
          <Btn full onClick={()=>{ setTab("arena"); notify("⬡ Use Arena to create/join an on-chain stake match.","info"); }} color="#b45309"
            disabled={!canAct||char.iota<stakeAmt||char.fightsToday>=RULES.maxFightsDay||char.hp<RULES.minHpToFight}>🔥 Stake {stakeAmt} IOTA</Btn>
          <Btn full onClick={doWork} color="#0d9488" disabled={!!loading||!canAct||char.energy<RULES.cost.work||char.worksToday>=RULES.maxWorksDay}>
            {loading==="work"?"⏳":"💼"} Work ({char.worksToday}/{RULES.maxWorksDay})</Btn>
          <Btn full onClick={doRob} color="#7c3aed" disabled={!!loading||!canAct||char.energy<RULES.cost.rob}>
            {loading==="rob"?"⏳":"🏦"} Rob ({RULES.robBaseChance+(sb?.robBonus||0)}%)</Btn>
          <Btn full onClick={doSleep} color="#4338ca" disabled={!!loading||char.energy>=ENERGY_MAX}>
            {loading==="sleep"?"⏳":"😴"} Sleep</Btn>
        </div>

        {/* Stake selector */}
        <div style={{display:"flex",gap:6,marginTop:8,flexWrap:"wrap",alignItems:"center"}}>
          <span style={{color:C.muted,fontSize:10}}>Stake:</span>
          {[0.25,0.5,1,2,5].map(a=>(
            <button key={a} onClick={()=>setStakeAmt(a)}
              style={{padding:"4px 10px",borderRadius:7,border:`2px solid ${stakeAmt===a?C.gold:C.border}`,
                background:stakeAmt===a?C.gold+"22":C.card2,color:stakeAmt===a?C.gold:C.muted,
                cursor:"pointer",fontSize:10,fontWeight:700}}>{a} IOTA</button>))}</div>

        {/* Food */}
        <Panel style={{marginTop:12}}>
          <div style={{color:C.sub,fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:1,marginBottom:10}}>🍔 Street Food</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(85px,1fr))",gap:8}}>
            {FOODS.map(f=>(
              <div key={f.id} style={{background:C.card2,border:`1px solid ${C.border}`,borderRadius:10,padding:8,textAlign:"center"}}>
                <div style={{fontSize:22}}>{f.icon}</div>
                <div style={{fontSize:9,color:C.text,fontWeight:700}}>{f.name}</div>
                <div style={{fontSize:8,color:C.muted}}>+{f.hunger}🍖 +{f.hp}❤️</div>
                <div style={{fontSize:10,color:C.gold,fontWeight:700,margin:"3px 0"}}>{f.cost} 💰</div>
                <Btn sm full onClick={()=>doEat(f)} color={C.green}
                  disabled={char.scash<f.cost||char.hunger>=HUNGER_MAX}>Buy</Btn>
              </div>))}</div></Panel>
          </div>
          <div>
{/* Activity */}
        <Panel>
          <div style={{color:C.sub,fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Activity</div>
          {activity.length===0?<div style={{color:C.muted,fontSize:12,textAlign:"center",padding:20}}>No activity yet — go earn, fight, or stake.</div>
          :activity.slice(0,10).map((a,i)=><ActRow key={i} {...a}/>)}</Panel>

<Panel style={{marginTop:12}}>
  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,marginBottom:10}}>
    <div style={{color:C.sub,fontSize:10,fontWeight:800,textTransform:"uppercase",letterSpacing:1}}>🧰 Armory</div>
    <Btn sm onClick={()=>setTab("armory")} color={C.accent}>Open</Btn>
  </div>
  <div style={{display:"grid",gap:8}}>
    {["weapon","offhand"].map(slot=>{
      const id=slot==="weapon"?char.weapon:char.offhand;
      const tier=slot==="weapon"?(char.weaponTier||0):(char.offhandTier||0);
      const item=id?BASE_ITEMS.find(i=>i.id===id):null;
      const stats=id?getItemStats(id,tier):{atk:0,def:0};
      return(
        <div key={slot} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,
          background:C.card2,border:`1px solid ${C.border}`,borderRadius:12,padding:"10px 10px"}}>
          <div style={{minWidth:0}}>
            <div style={{fontSize:9,color:C.muted,textTransform:"uppercase"}}>{slot}</div>
            <div style={{fontSize:12,fontWeight:900,color:item?C.text:C.muted,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>
              {item?`${item.icon} ${item.name}`:"— Empty —"}
              {item&&<Chip color={TIER_COLORS[tier]} style={{marginLeft:8,fontSize:8}}>{TIER_NAMES[tier]}</Chip>}
            </div>
          </div>
          <div style={{textAlign:"right",whiteSpace:"nowrap"}}>
            {stats.atk>0&&<div style={{fontSize:11,fontWeight:900,color:C.red}}>+{stats.atk} ATK</div>}
            {stats.def>0&&<div style={{fontSize:11,fontWeight:900,color:C.cyan}}>+{stats.def} DEF</div>}
            {(!stats.atk && !stats.def) && <div style={{fontSize:11,fontWeight:800,color:C.muted}}>—</div>}
          </div>
        </div>
      );
    })}
  </div>
</Panel>
          </div>
        </div>
      </>}}

      {/* ═══ ARMORY ═══ */}
      {tab==="armory"&&<>
        <Panel glow>
          <div style={{color:C.sub,fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>Currently Equipped</div>
          <div style={{display:"flex",gap:14,alignItems:"center"}}>
            <FighterSVG classId={char.presetId} pose="idle" w={80} weaponId={char.weapon} offhandId={char.offhand}/>
            <div style={{flex:1}}>
              {["weapon","offhand"].map(slot=>{
                const id=slot==="weapon"?char.weapon:char.offhand;
                const tier=slot==="weapon"?(char.weaponTier||0):(char.offhandTier||0);
                const item=id?BASE_ITEMS.find(i=>i.id===id):null;
                const stats=id?getItemStats(id,tier):{atk:0,def:0};
                const upgCost=id?getUpgradeCost(id,tier):Infinity;
                return(
                  <div key={slot} style={{marginBottom:8,padding:8,background:C.card2,borderRadius:10,border:`1px solid ${C.border}`}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <div>
                        <span style={{fontSize:9,color:C.muted,textTransform:"uppercase"}}>{slot}: </span>
                        <span style={{fontSize:12,fontWeight:700,color:item?C.text:C.muted}}>
                          {item?`${item.icon} ${item.name}`:"— Empty —"}</span>
                        {item&&<Chip color={TIER_COLORS[tier]} style={{marginLeft:6,fontSize:8}}>{TIER_NAMES[tier]}</Chip>}</div></div>
                    {item&&<div style={{display:"flex",gap:8,alignItems:"center",marginTop:4}}>
                      {stats.atk>0&&<span style={{color:C.red,fontSize:10,fontWeight:700}}>+{stats.atk} ATK</span>}
                      {stats.def>0&&<span style={{color:C.accent,fontSize:10,fontWeight:700}}>+{stats.def} DEF</span>}
                      {tier<item.maxTier&&<Btn sm onClick={()=>doUpgrade(slot)} color={C.gold}
                        disabled={char.scash<upgCost||!!loading} style={{marginLeft:"auto",fontSize:9}}>
                        ⬆️ Upgrade ({upgCost} 💰)</Btn>}
                      {tier>=item.maxTier&&<Chip color={C.gold} style={{marginLeft:"auto"}}>MAX</Chip>}</div>}
                  </div>);})}</div></div></Panel>
        <Panel>
          <div style={{color:C.sub,fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:1,marginBottom:10}}>⚔️ Black Market</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            {BASE_ITEMS.map(w=>{
              const eq=w.slot==="weapon"?char.weapon===w.id:char.offhand===w.id;
              const stats=getItemStats(w.id,0);
              return(
                <div key={w.id} style={{background:eq?C.accent+"11":C.card2,
                  border:`1px solid ${eq?C.accent:C.border}`,borderRadius:12,padding:12,textAlign:"center"}}>
                  <div style={{fontSize:28}}>{w.icon}</div>
                  <div style={{fontSize:11,color:C.text,fontWeight:700,marginTop:4}}>{w.name}</div>
                  <Chip color={w.slot==="weapon"?C.red:C.accent} style={{fontSize:8,marginTop:2}}>
                    {w.slot==="weapon"?"WEAPON":"OFFHAND"}</Chip>
                  <div style={{fontSize:10,color:C.muted,margin:"4px 0"}}>
                    {stats.atk>0&&<span style={{color:C.red,marginRight:4}}>+{stats.atk} ATK</span>}
                    {stats.def>0&&<span style={{color:C.accent}}>+{stats.def} DEF</span>}</div>
                  <div style={{fontSize:11,color:C.gold,fontWeight:700,margin:"4px 0"}}>{w.cost} SCASH</div>
                  {eq?<Chip color={C.green}>Equipped</Chip>
                  :<Btn sm full onClick={()=>doBuy(w)} color={C.accent} disabled={char.scash<w.cost||!!loading}>Buy</Btn>}
                </div>)})}</div></Panel>
      </>}

      {/* ═══ SKILLS ═══ */}
      {/* ═══ INVENTORY ═══ */}
{tab==="inventory"&&<>
  <Panel glow>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap"}}>
      <div>
        <div style={{fontWeight:900,color:C.text}}>Wallet Inventory</div>
        <div style={{fontSize:11,color:C.sub}}>Owned objects in your wallet (weapons & your Player object).</div>
      </div>
      <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
        <ConnectButton />
        <button onClick={()=>{refreshOwned();refreshMarket();}} style={btnSm(C.cyan)}>↻ Refresh</button>
      </div>
    </div>

    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginTop:10}}>
      <div>
        <div style={{fontSize:11,color:C.sub,fontWeight:800,marginBottom:6}}>Move config</div>
        <div style={{display:"grid",gap:8}}>
          <label style={{fontSize:11,color:C.sub}}>Network
            <select value={net} onChange={e=>setNet(e.target.value)}
              style={{width:"100%",marginTop:4,background:C.card2,border:`1px solid ${C.border}`,color:C.text,borderRadius:10,padding:"8px 10px"}}>
              <option value="testnet">testnet</option>
              <option value="mainnet">mainnet</option>
            </select>
          </label>
          <Input label="Package Id" value={pkg} onChange={setPkg} ph="0x…"/>
          <Input label="Player Type" value={playerType} onChange={setPlayerType} ph="0x…::player::Player"/>
          <Input label="Weapon Type" value={weaponType} onChange={setWeaponType} ph="0x…::items::Weapon"/>
          <Input label="MarketState (shared)" value={marketStateId} onChange={setMarketStateId} ph="0x…"/>
          <Input label="Clock (shared)" value={clockId} onChange={setClockId} ph="0x…"/>
          <Input label="Random (shared)" value={randomId} onChange={setRandomId} ph="0x…"/>
          <Input label="ArenaState (shared)" value={arenaStateId} onChange={setArenaStateId} ph="0x…"/>
          <Input label="Listing Id (shared)" value={listingId} onChange={setListingId} ph="0x…"/>
          <div style={{fontSize:11,color:C.muted}}>
            Address: <span style={{color:C.text,fontWeight:800}}>{account?.address?shortId(account.address):"—"}</span>{" "}
            Player: <span style={{color:C.text,fontWeight:800}}>{playerId?shortId(playerId):"—"}</span>
          </div>
        </div>
      </div>

      <div>
        <div style={{fontSize:11,color:C.sub,fontWeight:800,marginBottom:6}}>On-chain activity</div>
        <div style={{display:"grid",gap:6,maxHeight:210,overflow:"auto",paddingRight:4}}>
          {txFeed.length===0 && <div style={{fontSize:11,color:C.muted}}>No tx yet.</div>}
          {txFeed.map(t=>(
            <div key={t.id} style={{border:`1px solid ${C.border}`,borderRadius:12,padding:"8px 10px",background:C.card2}}>
              <div style={{display:"flex",justifyContent:"space-between",gap:10}}>
                <div style={{fontSize:11,color:C.text,fontWeight:800}}>{t.label}</div>
                <Chip color={t.status==="success"?C.green:t.status==="error"?C.red:C.cyan}>
                  {t.status==="pending"?"⏳ Pending":t.status==="success"?"✅ Success":"⚠️ Error"}
                </Chip>
              </div>
              {t.digest && <div style={{fontSize:11,color:C.sub,marginTop:4}}>digest: {shortId(t.digest)}</div>}
              {t.err && <div style={{fontSize:11,color:C.red,marginTop:4,whiteSpace:"pre-wrap"}}>{t.err}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  </Panel>

  <Panel>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap"}}>
      <div style={{fontWeight:900,color:C.text}}>Weapons ({weapons.length})</div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        <button
          onClick={async()=>{
            // Optional helper: mint a starter weapon if your Move package exposes it
            // Expected target: <pkg>::items::mint_starter_weapon(player)
            if(!pkg) return notify("Set package id");
            if(!playerId) return notify("No Player object found");
            await execMove({ label:"Mint Starter Kit (NFTs)", target:`${pkg}::items::mint_starter_kit`, args:[playerId, 0] });
            await refreshOwned();
          }}
          style={btnSm(C.purple)}
        >✨ Mint Starter Kit</button>
      </div>
    </div>

    {weapons.length===0 && <div style={{fontSize:11,color:C.muted,marginTop:8}}>No weapons found in wallet (type filter: {weaponType||"—"}).</div>}

    <div style={{display:"grid",gap:10,marginTop:10}}>
      {weapons.map((w,i)=>{
        const id=w?.data?.objectId;
        const f=asFields(w)||{};
        const name=f?.name || f?.display_name || `Weapon #${i+1}`;
        const lvl=toNum(f?.level ?? f?.lvl ?? 1, 1);
        const atk=toNum(f?.atk ?? f?.attack ?? 0, 0);
        const def=toNum(f?.def ?? f?.defense ?? 0, 0);
        const rarity=f?.rarity || f?.tier || "common";
        const ms=getMilestoneForLevel(lvl);
        const claimedRaw=(f?.claimed_milestones ?? f?.milestones_claimed ?? f?.rewards_claimed ?? "");
        const claimedSet=new Set(String(claimedRaw).split(/[^0-9]+/).filter(Boolean));
        const canClaim=ms>0 && !claimedSet.has(String(ms));
        const art=ms>0 ? milestoneArt(ms, String(name)).uri : "";
        return (
          <div key={id||i} style={{border:`1px solid ${C.border}`,borderRadius:14,padding:"10px 12px",background:C.card2}}>
            <div style={{display:"flex",justifyContent:"space-between",gap:10,flexWrap:"wrap"}}>
              <div>
                <div style={{fontWeight:900,color:C.text}}>{name} <span style={{color:C.muted,fontWeight:800}}>({shortId(id)})</span></div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:6}}>
                  <Chip color={C.cyan}>Lv {lvl}/50</Chip>
                  <Chip color={C.gold}>ATK {atk}</Chip>
                  <Chip color={C.green}>DEF {def}</Chip>
                  <Chip color={C.muted}>{String(rarity).toUpperCase()}</Chip>
                </div>
              </div>
              {art && (
                <div style={{marginTop:10,display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
                  <img src={art} alt={`milestone-${ms}`} style={{width:220,height:110,borderRadius:12,border:`1px solid ${C.border}`,background:C.card}}/>
                  <div style={{display:"grid",gap:6}}>
                    <div style={{fontSize:11,color:C.sub,fontWeight:800}}>Evolved NFT art unlocked (Lv {ms})</div>
                    <div style={{fontSize:11,color:C.muted}}>Upgrade milestones unlock cosmetic + reward claims. Stored on-chain when claimed.</div>
                    <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
                      <Chip color={C.purple}>Milestone {ms}</Chip>
                      {canClaim ? <Chip color={C.green}>Reward: READY</Chip> : ms>0 ? <Chip color={C.muted}>Reward: claimed/unknown</Chip> : null}
                    </div>
                  </div>
                </div>
              )}
              <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                <button
                  onClick={async()=>{
                    if(!pkg) return notify("Set package id");
                    if(!playerId) return notify("No Player object found");
                    if(!id) return notify("Bad weapon object");
                    // Expected target: <pkg>::player::equip_weapon(player, weapon)
                    await execMove({ label:`Equip ${name}`, target:`${pkg}::player::equip_weapon`, args:[playerId, id] });
                    // reflect locally too
                    setChar(prev=>({...prev, weapon: id}));
                  }}
                  style={btnSm(C.accent)}
                >Equip</button>

                <button
                  onClick={async()=>{
                    if(!pkg) return notify("Set package id");
                    if(!playerId) return notify("No Player object found");
                    if(!id) return notify("Bad weapon object");
                    if(lvl>=50) return notify("Max level");
                    // Expected target: <pkg>::crafting::upgrade_weapon(player, weapon)
                    await execMove({ label:`Upgrade ${name}`, target:`${pkg}::crafting::upgrade_weapon`, args:[playerId, id] });
                    await refreshOwned();
                  }}
                  style={btnSm(C.gold)}
                >⬆️ Upgrade</button>

                {canClaim && (
                  <button
                    onClick={async()=>{
                      if(!pkg) return notify("Set package id");
                      if(!playerId) return notify("No Player object found");
                      if(!id) return notify("Bad weapon object");
                      // Expected target: <pkg>::items::claim_weapon_milestone_reward(player, weapon, milestone)
                      await execMove({ label:`Claim Lv ${ms} reward`, target:`${pkg}::items::claim_weapon_milestone_reward`, args:[playerId, id, ms] });
                      await refreshOwned();
                    }}
                    style={btnSm(C.green)}
                  >🎁 Claim Lv {ms}</button>
                )}
              </div>
            </div>

            <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:8,marginTop:10,alignItems:"center"}}>
              <div style={{fontSize:11,color:C.sub}}>
                List on market (IOTA): enter price then list.
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <input
                  defaultValue="1"
                  id={`price-${id}`}
                  inputMode="decimal"
                  style={{width:110,background:C.card,border:`1px solid ${C.border}`,color:C.text,borderRadius:10,padding:"8px 10px"}}
                />
                <button
                  onClick={async()=>{
                    if(!pkg) return notify("Set package id");
                    if(!marketStateId) return notify("Set MarketState id");
                    const el=document.getElementById(`price-${id}`);
                    const priceIota=String(el?.value||"").trim();
                    const amt=iotaAmountFromUI(priceIota);
                    if(amt<=0n) return notify("Bad price");
                    // Expected target: <pkg>::market::list_weapon(marketState, weapon, price)
                    await execMove({ label:`List ${name}`, target:`${pkg}::market::list_weapon`, args:[marketStateId, id, iotaAmountFromUI(amt)] });
                    await refreshMarket();
                  }}
                  style={btnSm(C.cyan)}
                >List</button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  </Panel>
</>}

{/* ═══ MARKET ═══ */}

{tab==="market"&&<>
  <Panel glow>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap"}}>
      <div>
        <div style={{fontWeight:900,color:C.text}}>Marketplace (on-chain)</div>
        <div style={{fontSize:11,color:C.sub}}>
          Listings are shared objects. This UI keeps a local list of listing IDs you’ve created/seen (no indexer required).
        </div>
      </div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
        <ConnectButton />
        <button onClick={()=>{refreshMarket();refreshOwned();}} style={btnSm(C.cyan)}>↻ Refresh</button>
      </div>
    </div>

    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginTop:10}}>
      <Input label="Package Id" value={pkg} onChange={setPkg} ph="0x…"/>
      <Input label="MarketState (shared)" value={marketStateId} onChange={setMarketStateId} ph="0x…"/>
      <Input label="Add Listing Id (shared)" value={listingId} onChange={setListingId} ph="0x…"/>
      <div style={{display:"flex",gap:8,alignItems:"flex-end"}}>
        <button
          onClick={()=>{
            const id = String(listingId||"").trim();
            if(!id.startsWith("0x")) return notify("Paste a Listing object id (0x…)", "error");
            setKnownListingIds(prev => Array.from(new Set([id, ...(prev||[])])));
            setListingId("");
            notify("Listing saved locally.", "success");
            refreshMarket();
          }}
          style={btnSm(C.accent)}
        >Add</button>
        <button
          onClick={()=>{
            setKnownListingIds([]);
            notify("Cleared local listing registry.", "info");
            setListings([]);
          }}
          style={btnSm(C.red)}
        >Clear</button>
      </div>
    </div>
  </Panel>

  <Panel>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap"}}>
      <div>
        <div style={{fontWeight:900,color:C.text}}>Create Listing</div>
        <div style={{fontSize:11,color:C.muted}}>Lists an owned Weapon into escrow as a shared Listing.</div>
      </div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
        <Chip color={C.cyan}>Known listings: {knownListingIds.length}</Chip>
      </div>
    </div>

    <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr",gap:10,marginTop:10}}>
      <label style={{fontSize:11,color:C.sub}}>
        Weapon (owned object)
        <select
          value={listWeaponId}
          onChange={e=>setListWeaponId(e.target.value)}
          style={{width:"100%",marginTop:4,background:C.card2,border:`1px solid ${C.border}`,color:C.text,borderRadius:10,padding:"8px 10px"}}
        >
          <option value="">Select weapon…</option>
          {weapons.map((w,i)=>{
            const id=w?.data?.objectId;
            const f=asFields(w)||{};
            const nm=f?.name || f?.display_name || `Weapon #${i+1}`;
            const lvl=toNum(f?.level ?? f?.lvl ?? 1, 1);
            return <option key={id||i} value={id}>{nm} (Lv {lvl}) • {shortId(id||"")}</option>;
          })}
        </select>
      </label>
      <Input label="Price (IOTA)" value={listPriceIota} onChange={setListPriceIota} ph="1.0"/>
      <div style={{display:"flex",alignItems:"flex-end"}}>
        <button
          onClick={async()=>{
            if(!pkg) return notify("Set package id", "error");
            if(!marketStateId) return notify("Set MarketState id", "error");
            if(!listWeaponId) return notify("Select a weapon to list", "error");
            const priceNanos = iotaAmountFromUI(listPriceIota);
            if(priceNanos<=0n) return notify("Price must be > 0", "error");
            try{
              await execMove({
                label:"List weapon (on-chain)",
                target:`${pkg}::market::list_weapon`,
                args:[{object:marketStateId},{object:listWeaponId},{u64:priceNanos}]
              });
              await refreshOwned();
              await refreshMarket();
              notify("Listing created on-chain (saved locally).", "chain");
            }catch(e){
              notify("Listing failed (see tx feed).", "error");
            }
          }}
          style={btnSm(C.green)}
          disabled={!!loading}
        >List</button>
      </div>
    </div>
  </Panel>

  <Panel>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <div style={{fontWeight:900,color:C.text}}>Listings ({listings.length})</div>
    </div>

    {listings.length===0 && (
      <div style={{fontSize:11,color:C.muted,marginTop:8}}>
        No listings loaded. Add a Listing ID or create one to populate this list.
      </div>
    )}

    <div style={{display:"grid",gap:10,marginTop:10}}>
      {listings.map((l,i)=>{
        const id = l?.data?.objectId || `row-${i}`;
        const f = asFields(l) || {};
        const seller = String(f?.seller||"");
        const priceNanos = (()=>{ try { return BigInt(String(f?.price_nanos ?? 0)); } catch { return 0n; } })();
        const active = !!f?.active;
        const weapon = f?.weapon?.fields || f?.weapon || {};
        const kind = weapon?.kind ?? weapon?.weapon_kind;
        const lvl = weapon?.level ?? weapon?.weapon_level;
        const isMine = account?.address && seller && String(seller)===String(account.address);

        return (
          <div key={id} style={{border:`1px solid ${C.border}`,borderRadius:14,padding:"10px 12px",background:C.card2,opacity:active?1:0.6}}>
            <div style={{display:"flex",justifyContent:"space-between",gap:10,flexWrap:"wrap"}}>
              <div>
                <div style={{fontWeight:900,color:C.text}}>
                  Listing <span style={{color:C.muted,fontWeight:800}}>{shortId(String(id))}</span> {active?"" : <span style={{color:C.red}}>• inactive</span>}
                </div>
                <div style={{fontSize:11,color:C.sub,marginTop:6}}>
                  seller: <span style={{color:C.text,fontWeight:800}}>{seller?shortId(seller):"—"}</span> ·
                  weapon: <span style={{color:C.text,fontWeight:800}}>{kind!=null?`kind ${kind}`:"?"} / lv {lvl??"?"}</span>
                </div>
                <div style={{marginTop:6,display:"flex",gap:8,flexWrap:"wrap"}}>
                  <Chip color={C.gold}>price {formatIota(priceNanos)} IOTA</Chip>
                  <Chip color={C.cyan}>({String(priceNanos)} nanos)</Chip>
                </div>
              </div>

              <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                {!isMine && active && (
                  <button
                    onClick={async()=>{
                      if(!pkg) return notify("Set package id","error");
                      if(!marketStateId) return notify("Set MarketState id","error");
                      try{
                        await execMove({
                          label:"Buy weapon (on-chain)",
                          target:`${pkg}::market::buy_weapon`,
                          args:[{object:marketStateId},{object:id},{iota:priceNanos}]
                        });
                        await refreshOwned();
                        await refreshMarket();
                        notify("Bought on-chain. Weapon delivered to your wallet.","chain");
                      }catch(e){
                        notify("Buy failed (see tx feed).","error");
                      }
                    }}
                    style={btnSm(C.green)}
                  >Buy</button>
                )}
                {isMine && active && (
                  <button
                    onClick={async()=>{
                      if(!pkg) return notify("Set package id","error");
                      if(!marketStateId) return notify("Set MarketState id","error");
                      try{
                        await execMove({
                          label:"Cancel listing (on-chain)",
                          target:`${pkg}::market::cancel_listing`,
                          args:[{object:marketStateId},{object:id}]
                        });
                        await refreshMarket();
                        notify("Listing canceled. Weapon returned to your wallet.","chain");
                      }catch(e){
                        notify("Cancel failed (see tx feed).","error");
                      }
                    }}
                    style={btnSm(C.red)}
                  >Cancel</button>
                )}
                <button
                  onClick={()=>{
                    setKnownListingIds(prev => (prev||[]).filter(x=>String(x)!==String(id)));
                    notify("Removed from local registry.","info");
                    setListings(prev => (prev||[]).filter((o)=>String(o?.data?.objectId)!==String(id)));
                  }}
                  style={btnSm(C.muted)}
                >Hide</button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  </Panel>
</>}


{/* ═══ ARENA (STAKE MATCHES) ═══ */}
{tab==="arena"&&<>
  <Panel glow>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap"}}>
      <div>
        <div style={{fontWeight:900,color:C.text}}>⬡ Arena (stake matches)</div>
        <div style={{fontSize:11,color:C.sub}}>
          Uses on-chain escrow + mutual result voting. This UI tracks match IDs locally (no indexer required).
        </div>
      </div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
        <ConnectButton />
        <button onClick={()=>{refreshArena();refreshOwned();}} style={btnSm(C.cyan)}>↻ Refresh</button>
      </div>
    </div>

    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginTop:10}}>
      <Input label="Package Id" value={pkg} onChange={setPkg} ph="0x…"/>
      <Input label="ArenaState (shared)" value={arenaStateId} onChange={setArenaStateId} ph="0x…"/>
      <Input label="Clock (shared)" value={clockId} onChange={setClockId} ph="0x…"/>
      <Input label="Add Match Id (shared)" value={matchIdInput} onChange={setMatchIdInput} ph="0x…"/>
      <div style={{display:"flex",gap:8,alignItems:"flex-end"}}>
        <button
          onClick={()=>{
            const id = String(matchIdInput||"").trim();
            if(!id.startsWith("0x")) return notify("Paste a Match object id (0x…)", "error");
            setKnownMatchIds(prev => Array.from(new Set([id, ...(prev||[])])));
            setMatchIdInput("");
            notify("Match saved locally.", "success");
            refreshArena();
          }}
          style={btnSm(C.accent)}
        >Add</button>
        <button
          onClick={()=>{
            setKnownMatchIds([]);
            setMatches([]);
            notify("Cleared local match registry.", "info");
          }}
          style={btnSm(C.red)}
        >Clear</button>
      </div>
    </div>
  </Panel>

  <Panel>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap"}}>
      <div>
        <div style={{fontWeight:900,color:C.text}}>Create Match</div>
        <div style={{fontSize:11,color:C.muted}}>Escrows stake in the shared Match; you receive a ResultCap.</div>
      </div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
        <Chip color={C.cyan}>Known matches: {knownMatchIds.length}</Chip>
        <Chip color={C.purple}>ResultCaps: {resultCaps.length}</Chip>
      </div>
    </div>

    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginTop:10}}>
      <Input label="Stake per side (IOTA)" value={stakeCreateIota} onChange={setStakeCreateIota} ph="1.0"/>
      <div style={{display:"flex",alignItems:"flex-end"}}>
        <button
          onClick={async()=>{
            if(!pkg) return notify("Set package id","error");
            if(!arenaStateId) return notify("Set ArenaState id","error");
            if(!clockId) return notify("Set Clock id","error");
            if(!playerId) return notify("No Player object found (register first)","error");
            const stakeNanos = iotaAmountFromUI(stakeCreateIota);
            if(stakeNanos<=0n) return notify("Stake must be > 0","error");
            try{
              await execMove({
                label:"Create match (on-chain)",
                target:`${pkg}::arena::create_match`,
                args:[{object:arenaStateId},{object:playerId},{iota:stakeNanos},{object:clockId}]
              });
              await refreshOwned();
              await refreshArena();
              notify("Match created (saved locally). Share the Match ID with an opponent.","chain");
            }catch(e){
              notify("Create match failed (see tx feed).","error");
            }
          }}
          style={btnSm(C.green)}
          disabled={!!loading}
        >Create</button>
      </div>

      <div style={{display:"flex",alignItems:"flex-end",gap:8}}>
        <Input label="Join stake (IOTA)" value={stakeJoinIota} onChange={setStakeJoinIota} ph="must equal stake"/>
      </div>
    </div>
  </Panel>

  <Panel>
    <div style={{fontWeight:900,color:C.text}}>Matches ({matches.length})</div>
    {matches.length===0 && (
      <div style={{fontSize:11,color:C.muted,marginTop:8}}>
        No matches loaded. Create one or add a Match ID.
      </div>
    )}

    <div style={{display:"grid",gap:10,marginTop:10}}>
      {matches.map((mo,i)=>{
        const id = mo?.data?.objectId || `m-${i}`;
        const f = asFields(mo) || {};
        const creator = String(f?.creator||"");
        const joiner = String(f?.joiner?.some ?? f?.joiner ?? "");
        const stakePer = (()=>{ try { return BigInt(String(f?.stake_per_side ?? 0)); } catch { return 0n; } })();
        const settled = !!f?.settled;
        const winner = String(f?.winner?.some ?? f?.winner ?? "");
        const claimedCreator = !!f?.claimed_creator;
        const claimedJoiner = !!f?.claimed_joiner;

        const amCreator = account?.address && creator && String(creator)===String(account.address);
        const amJoiner = account?.address && joiner && String(joiner)===String(account.address);

        // Find my ResultCap for this match (owned object)
        const myCapObj = (resultCaps||[]).find((c)=>{
          const cf = asFields(c) || {};
          const ma = String(cf?.match_addr ?? "");
          const owner = String(cf?.owner ?? "");
          return ma && owner && ma===String(id) && owner===String(account?.address||"");
        });
        const myCapId = myCapObj?.data?.objectId || "";

        return (
          <div key={id} style={{border:`1px solid ${C.border}`,borderRadius:14,padding:"10px 12px",background:C.card2}}>
            <div style={{display:"flex",justifyContent:"space-between",gap:10,flexWrap:"wrap"}}>
              <div>
                <div style={{fontWeight:900,color:C.text}}>
                  Match <span style={{color:C.muted,fontWeight:800}}>{shortId(String(id))}</span>
                  {settled ? <span style={{color:C.green}}> • settled</span> : <span style={{color:C.gold}}> • open</span>}
                </div>
                <div style={{fontSize:11,color:C.sub,marginTop:6}}>
                  creator: <span style={{color:C.text,fontWeight:800}}>{creator?shortId(creator):"—"}</span>{" "}
                  joiner: <span style={{color:C.text,fontWeight:800}}>{joiner?shortId(joiner):"—"}</span>
                </div>
                <div style={{marginTop:6,display:"flex",gap:8,flexWrap:"wrap"}}>
                  <Chip color={C.gold}>stake {formatIota(stakePer)} IOTA</Chip>
                  <Chip color={C.cyan}>{String(stakePer)} nanos</Chip>
                  {winner && <Chip color={C.green}>winner {shortId(winner)}</Chip>}
                  {myCapId && <Chip color={C.purple}>cap {shortId(myCapId)}</Chip>}
                </div>
              </div>

              <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                {!settled && !joiner && (
                  <button
                    onClick={async()=>{
                      if(!pkg) return notify("Set package id","error");
                      if(!playerId) return notify("No Player object found","error");
                      const stakeNanos = iotaAmountFromUI(stakeJoinIota);
                      if(stakeNanos<=0n) return notify("Stake must be > 0","error");
                      try{
                        await execMove({
                          label:"Join match (on-chain)",
                          target:`${pkg}::arena::join_match`,
                          args:[{object:playerId},{object:id},{iota:stakeNanos}]
                        });
                        await refreshOwned();
                        await refreshArena();
                        notify("Joined match. You received a ResultCap.","chain");
                      }catch(e){
                        notify("Join failed (see tx feed).","error");
                      }
                    }}
                    style={btnSm(C.accent)}
                  >Join</button>
                )}

                {!settled && !joiner && amCreator && (
                  <button
                    onClick={async()=>{
                      if(!pkg) return notify("Set package id","error");
                      try{
                        await execMove({
                          label:"Cancel match (on-chain)",
                          target:`${pkg}::arena::cancel_match`,
                          args:[{object:id}]
                        });
                        await refreshArena();
                        notify("Match canceled. Stake returned.","chain");
                      }catch(e){
                        notify("Cancel failed (see tx feed).","error");
                      }
                    }}
                    style={btnSm(C.red)}
                  >Cancel</button>
                )}

                {!settled && joiner && myCapId && (
                  <button
                    onClick={async()=>{
                      if(!pkg) return notify("Set package id","error");
                      if(!clockId) return notify("Set Clock id","error");
                      if(!playerId) return notify("No Player object found","error");
                      const winnerAddr = (stakeWinnerAddr||"").trim() || (account?.address||"");
                      if(!winnerAddr.startsWith("0x")) return notify("Set a winner address (0x…)", "error");
                      try{
                        await execMove({
                          label:"Submit result vote (on-chain)",
                          target:`${pkg}::arena::submit_result`,
                          args:[{object:playerId},{object:myCapId},{object:id},winnerAddr,{object:clockId}]
                        });
                        await refreshOwned();
                        await refreshArena();
                        notify("Vote submitted. If both votes match, match will settle & pay winner.","chain");
                      }catch(e){
                        notify("Submit result failed (see tx feed).","error");
                      }
                    }}
                    style={btnSm(C.gold)}
                  >Vote</button>
                )}

                {settled && (amCreator || amJoiner) && (
                  <button
                    onClick={async()=>{
                      if(!pkg) return notify("Set package id","error");
                      if(!clockId) return notify("Set Clock id","error");
                      if(!playerId) return notify("No Player object found","error");
                      const already = amCreator ? claimedCreator : claimedJoiner;
                      if(already) return notify("Already claimed.","info");
                      try{
                        await execMove({
                          label:"Claim result (on-chain)",
                          target:`${pkg}::arena::claim_result`,
                          args:[{object:playerId},{object:id},{object:clockId}]
                        });
                        await refreshOwned();
                        await refreshArena();
                        await refreshPlayerFromChain();
                        notify("Claimed: progression applied + receipt minted.","chain");
                      }catch(e){
                        notify("Claim failed (see tx feed).","error");
                      }
                    }}
                    style={btnSm(C.green)}
                  >Claim</button>
                )}

                <button
                  onClick={()=>{
                    setKnownMatchIds(prev => (prev||[]).filter(x=>String(x)!==String(id)));
                    setMatches(prev => (prev||[]).filter((o)=>String(o?.data?.objectId)!==String(id)));
                    notify("Removed from local registry.","info");
                  }}
                  style={btnSm(C.muted)}
                >Hide</button>
              </div>
            </div>

            {!settled && joiner && (
              <div style={{marginTop:10,display:"grid",gridTemplateColumns:"2fr 1fr",gap:10,alignItems:"end"}}>
                <Input label="Winner address (0x…)" value={stakeWinnerAddr} onChange={setStakeWinnerAddr} ph="default: your address"/>
                <div style={{fontSize:11,color:C.muted}}>
                  Both players must submit the same winner address for settlement.
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  </Panel>
</>}

{tab==="skills"&&(()=>{
        const classId=char.presetId,skills=char.skills||{},level=char.level||1;
        const col=CLASS_COL[classId];
        const tree=SKILL_TREES[classId]||[],availSP=getAvailSP(level,skills);
        return(<>
          <Panel glow>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <div><div style={{color:C.text,fontWeight:900,fontSize:16}}>{CLASS_NAME[classId]} Skills</div>
                <div style={{color:C.muted,fontSize:11}}>Level {level} · {Object.keys(skills).length}/{getTotalSP(level)} SP</div></div>
              <div style={{textAlign:"right"}}>
                <div style={{color:availSP>0?C.gold:C.muted,fontWeight:900,fontSize:18}}>{availSP}</div>
                <div style={{color:C.muted,fontSize:9}}>Available SP</div></div></div>
            <XPBar xp={char.xp||0} name={char.name} classId={classId}/>
          </Panel>
          <Panel>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
              {tree.map(node=>{
                const owned=!!skills[node.id],prereqOk=isUnlockable(node.id,skills),canSpend=prereqOk&&!owned&&availSP>0;
                return(
                  <div key={node.id} onClick={()=>canSpend&&doSpendSkill(node.id)}
                    style={{background:owned?col+"22":canSpend?C.card2:C.bg,
                      border:`2px solid ${owned?col:canSpend?col+"66":C.border}`,
                      borderRadius:12,padding:10,textAlign:"center",
                      cursor:canSpend?"pointer":"default",transition:"all 0.2s",
                      boxShadow:owned?`0 0 12px ${col}44`:"none",
                      opacity:!prereqOk&&!owned?0.4:1,
                      animation:canSpend?"pulse 2s infinite":"none"}}>
                    <div style={{fontSize:22}}>{node.icon}</div>
                    <div style={{fontSize:10,color:owned?col:C.text,fontWeight:700,marginTop:2}}>{node.name}</div>
                    <div style={{fontSize:8,color:C.muted,marginTop:2}}>{node.desc}</div>
                    {node.ultimate&&<Chip color={C.gold} style={{marginTop:4,fontSize:7}}>ULTIMATE</Chip>}
                    <div style={{marginTop:4,fontSize:9,color:owned?C.green:canSpend?C.gold:C.muted,fontWeight:700}}>
                      {owned?"✓ Unlocked":canSpend?"Click to learn":"🔒 Locked"}</div>
                  </div>);})}</div></Panel>
        </>);})()}

      {/* ═══ LEADERBOARD ═══ */}
      {tab==="leaderboard"&&<Panel>
        <div style={{color:C.sub,fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:1,marginBottom:10}}>🏆 Global Rankings</div>
        {[{rank:"—",name:char.name,cls:char.presetId,elo:char.elo,wins:char.wins,losses:char.losses,isYou:true},
          ...LEADERBOARD].sort((a,b)=>b.elo-a.elo).map((p,i)=>(
          <div key={i} style={{display:"flex",alignItems:"center",gap:10,padding:"8px",
            borderBottom:`1px solid ${C.border}22`,background:p.isYou?C.accent+"11":"transparent",borderRadius:p.isYou?8:0}}>
            <div style={{width:24,textAlign:"center",fontWeight:900,fontSize:14,
              color:i===0?C.gold:i===1?"#c0c0c0":i===2?"#cd7f32":C.muted}}>#{i+1}</div>
            <div style={{width:8,height:8,borderRadius:"50%",background:CLASS_COL[p.cls]||C.muted}}/>
            <div style={{flex:1}}>
              <div style={{fontSize:12,fontWeight:700,color:p.isYou?C.accent:C.text}}>
                {p.name}{p.isYou?" (You)":""}</div></div>
            <div style={{textAlign:"right"}}>
              <div style={{fontSize:13,fontWeight:900,color:C.cyan}}>{p.elo}</div>
              <div style={{fontSize:9,color:C.muted}}>W{p.wins}/L{p.losses}</div></div>
          </div>))}</Panel>}

      {/* Bottom nav */}
      <div style={{position:"fixed",bottom:0,left:0,right:0,background:C.card,
        borderTop:`1px solid ${C.border}`,padding:"8px 0",zIndex:100}}>
        <div style={{display:"flex",justifyContent:"center",gap:6,maxWidth:520,margin:"0 auto"}}>
          {TABS.map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)}
              style={{padding:"4px 14px",borderRadius:99,border:"none",
                background:tab===t.id?C.accent+"33":"transparent",
                color:tab===t.id?C.accent:C.muted,cursor:"pointer",fontSize:11,fontWeight:700}}>{t.label}</button>))}</div></div>
    </div>);
}

export default function App(){
  const queryClient = useMemo(() => new QueryClient(), []);
  // Provider wrapper for Wallet + RPC. Change default network here if needed.
  const [network,setNetwork]=useState("testnet");
  const rpcUrl = NETS[network] || NETS.testnet;

  // Keep providers stable; if you switch network in UI, this wrapper can be adapted to re-mount via key.
  return (
    <QueryClientProvider client={queryClient}>
    <IotaClientProvider networks={{ [network]: { url: rpcUrl } }} defaultNetwork={network}>
      <WalletProvider autoConnect>
        <AppInner />
      </WalletProvider>
    </IotaClientProvider>
    </QueryClientProvider>
  );
}
