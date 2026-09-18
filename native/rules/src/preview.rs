use crate::recruit::Recruit;
use crate::recruit_effects::{Context,keyword};
use crate::{Result,arr,catalog,def,num,str_field,tribe,truth,primitives,abilities,stats};
use serde_json::{Value,json};
const VOLUMIZERS:[&str;3]=["BG34_170t","BG34_170t2","BG34_170t3"];
impl Recruit {
 pub fn bonus_keyword(&mut self,uid:&str)->Result<()>{let m=self.owned(uid)?;let ks=["嘲讽","圣盾","复生","风怒","烈毒"].into_iter().filter(|k|!arr(&m["keywords"]).contains(&json!(k))).collect::<Vec<_>>();if let Some(k)=ks.get(self.index(ks.len())){keyword(self.owned_mut(uid)?,k);}Ok(())}
 fn grant(&mut self,ctx:&Context,id:&str,n:f64)->Result<()>{for _ in 0..n.ceil().max(0.) as usize{let m=self.make(&format!("s14_{id}"),false,false)?;self.give(ctx,m)?;}Ok(())}
 pub fn preview_effect(&mut self,ctx:&Context,m:&Value,a:&Value)->Result<()>{let f=if truth(&a["noScale"]){a["amount"].as_f64().unwrap_or(1.)}else if truth(&m["golden"]){2.}else{1.};let id=a["key"].as_str().unwrap_or(def(str_field(m,"id")?)?["sourceId"].as_str().unwrap_or(""));let uid=str_field(m,"uid")?;if a["target"]=="selectedHand"{let Some(t)=&ctx.target else{return Ok(())};if !self.discard(ctx,t)?{return Ok(())}}
 let gain=|s:&mut Self,t:&str,attack:f64,health:f64|s.gain(t,attack,health,Some(m),ctx.depth);
 let act=|s:&mut Self,attack:f64,health:f64,target:&str|s.effect(ctx,m,&json!({"event":"cast","op":"buff","target":target,"attack":attack,"health":health}));
 match id {
 "BG32_337"=>if ctx.target.is_some(){let mut ks=vec![];for m in arr(&self.state["board"]){for k in arr(&m["keywords"]){if !ks.contains(k){ks.push(k.clone());}}}for _ in 0..1+ks.len(){act(self,1.,1.,"selected")?;}},
 "BG35_910"=>{let n=4.+self.count(&format!("elementalsPlayed:{}",self.state["turn"]));act(self,n,n,"selected")?;},
 "BG35_911"=>{let target=arr(&self.state["shop"]).iter().enumerate().max_by(|(i,a),(j,b)|num(&a["health"]).total_cmp(&num(&b["health"])).then(j.cmp(i))).map(|(_,m)|m.clone());if let Some(t)=target&&ctx.target.is_some(){act(self,(num(&t["attack"])/2.).ceil(),(num(&t["health"])/2.).ceil(),"selected")?;}},
 "BG34_272"=>for _ in 0..1+self.board_types()?{act(self,3.,3.,"all")?;},
 "BG32_MagicItem_892t"=>if let Some(t)=&ctx.target{self.bonus_keyword(t)?;},
 "BG36_099"|"BG36_110"=>{self.deity_gain(2.*f,2.*f);},
 "BG36_300"=>self.scale("spell",f,f)?,
 "BG36_311"=>for _ in 0..f as usize{if let Some(c)=self.draw_spell(|_|true)?{self.give(ctx,c)?;}},
 "BG36_312"=>{let tier=num(&self.state["tier"]);for _ in 0..f as usize{if let Some(c)=self.draw(|d|num(&d["tier"])<=tier&&(arr(&d["races"]).contains(&json!("畸变怪"))||d["tribe"]=="全部"))?{self.give(ctx,c)?;}}},
 "BG28_582"=>self.grant(ctx,"BG20_GEM",3.*f)?,
 "BG36_100"|"BG36_308"=>for _ in 0..f as usize{self.linked_cards(ctx,id=="BG36_100",true)?;},
 "BG36_102"=>{},
 "BG36_106"=>{gain(self,uid,4.*f,4.*f)?;self.deity_gain(4.*f,4.*f);},
 "BG36_108"=>{gain(self,uid,f,3.*f)?;self.deity_gain(f,3.*f);if self.item("BG36_MagicItem_402")>0{let ids=self.neighbors(uid);for t in ids{gain(self,&t,f,3.*f)?;}}},
 "BG36_111"=>{for t in self.board_ids(){gain(self,&t,4.*f,3.*f)?;}self.deity_gain(4.*f,3.*f);},
 "BG36_113"=>{self.deity_gain(2.*f,f);},
 "BG36_114"=>if let Some(t)=self.board_ids().first(){let n=(2.+self.count("discarded"))*f;gain(self,t,n,n)?;},
 "BG36_318"=>{let n=(1.+num(&self.state["season"]["spellsCast"]))*f;self.deity_gain(n,n);},
 "BG36_320"=>{let cards=arr(&self.state["hand"]).iter().filter(|m|arr(&catalog().data["tavernSpellIds"]).contains(&m["id"])).take(3).cloned().collect::<Vec<_>>();for c in cards{if self.discard(ctx,str_field(&c,"uid")?)?{gain(self,uid,8.*f,8.*f)?;}}},
 "BGFYM_005"=>{let n=self.mbump(uid,"harbinger",1.)?*f;self.deity_gain(n,n);},
 "BG36_301t"=>for _ in 0..2{self.cast_spell(&Context{from_hand:false,..ctx.clone()},m)?;},
 "BG36_371"=>if a["event"]=="cast"{self.deity_gain(7.*f,7.*f);}else{for _ in 0..2{self.cast_spell(&Context{from_hand:false,..ctx.clone()},m)?;}},
 "BG36_MagicItem_417t"=>if let Some(t)=&ctx.target{let turn=self.state["turn"].clone();self.mbump(t,"deityMirrorCopies",1.)?;self.owned_mut(t)?["counters"]["deityMirrorTurn"]=turn;},
 "BG36_360t5"=>{let ty=self.majority()?;let tier=num(&self.state["tier"]);for _ in 0..f as usize{if let Some(c)=self.draw(|d|num(&d["tier"])<=tier&&(ty.is_none()||arr(&d["races"]).contains(&json!(ty))||d["tribe"]=="全部"))?{self.give(ctx,c)?;}}},
 "BG36_360t9"=>{let mut c=self.make("s14_BG36_360t9",false,false)?;c["extraAbilities"]=json!([]);c["attack"]=json!(num(&m["attack"])*f);let h=num(&m["counters"]["deathStatsHealth"]);c["health"]=json!(if h!=0.{h}else{num(&def(str_field(m,"id")?)?["health"])}*f);c["id"]=json!("s14_BG29_864t");if ctx.summon_cursor.is_some(){self.summon(ctx,c)?;}},
 "BG36_362"=>if a["event"]=="activate"{self.mbump(uid,"wrathguard",1.)?;}else{let n=2.*(1.+num(&m["counters"]["wrathguard"]))*f;self.scale("shop",n,n)?;},
 "BG36_364"=>if a["event"]=="shieldLost"{self.mbump(uid,"hope",1.)?;}else{let n=(3.+num(&m["counters"]["hope"]))*f;for t in self.board_ids(){gain(self,&t,n,n)?;}},
 "BG36_366"=>for _ in 0..f as usize{let id=VOLUMIZERS[self.index(3)];let c=self.make(&format!("s14_{id}"),false,false)?;let c=stats::sync(&self.state,c,false)?;self.magnetize(ctx,uid,c)?;self.grant(ctx,id,1.)?;},
 "BG36_367"=>if self.mbump(uid,"autoPurchases",1.)?%3.==0.{for _ in 0..f as usize{let id=VOLUMIZERS[self.index(3)];self.grant(ctx,id,1.)?;}},
 "BG36_369"=>if truth(&m["golden"]){self.queue("minion",json!({"tiers":[7]}))?;},
 "BG36_370"=>for _ in 0..(6.*f) as usize{if self.room(){self.grant(ctx,"BG20_GEM",1.)?;}else if let Some(t)=self.board_ids().first(){self.effect(&Context{target:Some(t.clone()),..ctx.clone()},m,&json!({"event":"activate","op":"gem","target":"selected","noScale":true}))?;}},
 "BG36_700"=>if let Some(t)=&ctx.target{gain(self,t,7.*f,7.*f)?;for _ in 0..f as usize{self.bonus_keyword(t)?;}},
 "BG36_848"=>{let ids=self.board_ids();if let Some(t)=ids.get(self.index(ids.len())){let c=self.owned(t)?;let id=str_field(def(str_field(&c,"id")?)?,"sourceId")?;self.grant(ctx,id,f)?;}},
 "BG36_849"=>if a["event"]=="rally"{keyword(self.owned_mut(uid)?,"圣盾");}else{self.mbump(uid,"immediateAttack",0.)?;self.owned_mut(uid)?["counters"]["immediateAttack"]=json!(f);},
 "BGFYM_000"=>{let ids=arr(&self.state["board"]).iter().filter(|x|x["uid"]!=uid&&num(&x["health"])>0.).map(|x|str_field(x,"uid").map(str::to_owned)).collect::<Result<Vec<_>>>()?;if !ids.is_empty(){let mut allocations=vec![(0.,0.);ids.len()];for _ in 0..(num(&m["attack"])*f).ceil().max(0.) as usize{allocations[self.index(ids.len())].0+=1.;}for _ in 0..(num(&m["health"])*f).ceil().max(0.) as usize{allocations[self.index(ids.len())].1+=1.;}for (i,t) in ids.iter().enumerate(){gain(self,t,allocations[i].0,allocations[i].1)?;}}},
 "BGFYM_011"=>{},
 "BG34_170"|"BG34_171"=>for _ in 0..f as usize{let id=VOLUMIZERS[self.index(3)];self.grant(ctx,id,1.)?;},
 "BG34_170t"|"BG34_170t2"|"BG34_170t3"=>if num(&m["counters"]["volumizerUsed"])==0.{self.mbump(uid,"volumizerUsed",1.)?;self.scale("volumizer",if id=="BG34_170t"{3.*f}else if id=="BG34_170t3"{f}else{0.},if id=="BG34_170t2"{3.*f}else if id=="BG34_170t3"{f}else{0.})?;self.sync_all()?;let m=stats::sync(&self.state,self.owned(uid)?,false)?;*self.owned_mut(uid)?=m;},
 "BG31_149"=>for _ in 0..f as usize{self.bonus_keyword(uid)?;},
 "BG32_231"=>{let mut cards=arr(&self.state["board"]).iter().filter(|x|tribe(x,"海盗").unwrap_or(false)&&!truth(&x["golden"])&&num(&def(x["id"].as_str().unwrap()).unwrap()["tier"])<=4.).cloned().collect::<Vec<_>>();self.shuffle(&mut cards);for x in cards.into_iter().take(f as usize){*self.owned_mut(str_field(&x,"uid")?)?=primitives::golden(x)?;}},
 "BG35_882"=>self.grant(ctx,"BG35_910",f)?,
 "BGS_008"=>for _ in 0..(2.*f) as usize{let ds=self.pool_cards()?.into_iter().filter(|d|arr(&d["abilities"]).iter().any(|a|a["event"]=="death")).collect::<Vec<_>>();if let Some(d)=ds.get(self.index(ds.len()))&&ctx.summon_cursor.is_some(){let c=self.make(str_field(d,"id")?,false,false)?;self.summon(ctx,c)?;}},
 "BG31_148"=>{let mut ks=vec![];for x in arr(&self.state["board"]){for k in arr(&x["keywords"]){if !ks.contains(k){ks.push(k.clone());}}}let n=1.+ks.len() as f64;for t in self.board_ids(){if t!=uid{gain(self,&t,3.*f*n,2.*f*n)?;}}},
 "BG31_812"=>if let Some(t)=&ctx.event_minion{let x=self.owned_mut(t)?;let had=arr(&x["keywords"]).contains(&json!("圣盾"));keyword(x,"圣盾");if !truth(&m["golden"])&&!had{if !x["temporary"].is_object(){x["temporary"]=json!({"attack":0,"health":0,"keywords":[]});}x["temporary"]["keywords"].as_array_mut().unwrap().push(json!("圣盾"));}},
 "BGS_040"=>{let mut ids=arr(&self.state["board"]).iter().filter(|x|tribe(x,"龙").unwrap_or(false)).map(|x|str_field(x,"uid").map(str::to_owned)).collect::<Result<Vec<_>>>()?;self.shuffle(&mut ids);for t in ids.into_iter().take((3.*f) as usize){keyword(self.owned_mut(&t)?,"圣盾");}},
 "BG34_405"=>keyword(self.owned_mut(uid)?,"圣盾"),
 "BG31_810"=>if a["event"]=="playElemental"{self.mbump(uid,"ultraviolet",1.)?;}else{let n=1.+num(&m["counters"]["ultraviolet"]);for t in self.board_ids(){if t!=uid&&tribe(&self.owned(&t)?,"元素")?{gain(self,&t,3.*f*n,2.*f*n)?;}}},
 "BG22_403"=>{let mut ids=self.neighbors(uid);if !truth(&m["golden"]){ids=ids.get(self.index(ids.len())).cloned().into_iter().collect();}for t in ids{self.battlecry(ctx,&t)?;}},
 _=>return Err(format!("Unknown preview card: {id}"))
 }Ok(())}
 pub fn neighbors(&self,uid:&str)->Vec<String>{let ids=self.board_ids();let i=ids.iter().position(|id|id==uid).map(|i|i as isize).unwrap_or(-1);[i-1,i+1].into_iter().filter(|i|*i>=0).filter_map(|i|ids.get(i as usize).cloned()).collect()}
}
