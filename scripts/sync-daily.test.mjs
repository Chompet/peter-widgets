import assert from "node:assert/strict";
import { createDecipheriv, randomBytes } from "node:crypto";
import test from "node:test";
import { buildDashboard, encryptDashboard } from "./sync-daily.mjs";

const title=value=>({type:"title",title:value?[{plain_text:value}]:[]});
const rich=value=>({type:"rich_text",rich_text:value?[{plain_text:value}]:[]});
const select=value=>({type:"select",select:value?{name:value}:null});
const status=value=>({type:"status",status:value?{name:value}:null});
const checkbox=value=>({type:"checkbox",checkbox:value});
const date=value=>({type:"date",date:value?{start:value}:null});
const created=value=>({type:"created_time",created_time:value});
const multi=values=>({type:"multi_select",multi_select:values.map(name=>({name}))});

function task(name,{due=null,priority="Normal",statusName="Not Started",mission=false,next=false,energy="🙂 Normal",estimate="30 min",completed=null}={}){
  return {properties:{Task:title(name),Status:select(statusName),Priority:select(priority),Area:select("🎵 Music"),Estimate:select(estimate),Energy:select(energy),Due:date(due),"Completed On":date(completed),Mission:checkbox(mission),"Next Action":checkbox(next),Notes:rich("PRIVATE task note"),Project:{relation:[{id:"PRIVATE-project"}]}}};
}
function event(name,when){return {properties:{Name:title(name),When:date(when),Area:select("Career"),"Event Type":select("Interview"),Confirmed:checkbox(true),Completed:checkbox(false),Location:rich("PRIVATE exact address"),Notes:rich("PRIVATE event note")}};}
function session(name,started,finished,goal=false){return {properties:{Title:title(name),Started:created(started),Finished:date(finished),Area:select("🎵 Music"),Category:multi(["🎛 Mixing"]),Status:status(finished?"✅ Complete":"🟢 Running"),"Goal of the session achieved?":checkbox(goal),Summary:rich("PRIVATE summary"),Problems:rich("PRIVATE problem"),"Next Session":rich("PRIVATE next session")}};}

test("ranks missions and overdue next actions while excluding private fields",()=>{
  const tasks=[
    task("Ordinary task",{due:"2026-07-20",priority:"Normal"}),
    task("Overdue action",{due:"2026-07-16",priority:"High",next:true}),
    task("Daily mission",{due:"2026-07-18",priority:"Normal",mission:true})
  ];
  const result=buildDashboard(tasks,[event("Interview","2026-07-17T12:00:00Z")],[session("Mixing session","2026-07-17T09:00:00Z","2026-07-17T10:30:00Z",true)],new Date("2026-07-17T14:00:00Z"));
  assert.equal(result.focus.title,"Daily mission");
  assert.equal(result.counts.overdue,1);
  assert.equal(result.schedule.today[0].name,"Interview");
  assert.equal(result.work.minutes,90);
  assert.equal(result.work.goals,1);
  assert.equal(JSON.stringify(result).includes("PRIVATE"),false);
});

test("uses London dates around the UTC boundary and reports data quality",()=>{
  const tasks=[task("Late evening task",{due:"2026-07-18",mission:true,estimate:"",energy:""})];
  const work=[session("Late work","2026-07-17T23:30:00Z","2026-07-18T00:30:00Z")];
  const result=buildDashboard(tasks,[],work,new Date("2026-07-17T23:45:00Z"));
  assert.equal(result.today,"2026-07-18");
  assert.equal(result.work.sessions,1);
  assert.equal(result.counts.dueToday,1);
  assert.equal(result.quality.missingEstimate,1);
  assert.equal(result.quality.missingEnergy,1);
});

test("encrypts with AES-256-GCM",()=>{
  const key=randomBytes(32); const data={focus:{title:"Do the thing"},counts:{active:4}};
  const payload=encryptDashboard(data,key.toString("base64url")); const bytes=Buffer.from(payload.ciphertext,"base64url");
  const decipher=createDecipheriv("aes-256-gcm",key,Buffer.from(payload.iv,"base64url")); decipher.setAuthTag(bytes.subarray(-16));
  const clear=Buffer.concat([decipher.update(bytes.subarray(0,-16)),decipher.final()]); assert.deepEqual(JSON.parse(clear.toString("utf8")),data);
});
