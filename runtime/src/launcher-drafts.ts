// Private unacknowledged launcher requests, never a queue or history replica.
import { createHash,randomUUID } from "node:crypto";
import { mkdir,lstat,open,link,rm,readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute,join } from "node:path";
import { type LauncherRequest,validRexUuid } from "./generated/contracts.js";
import { validLaunchRequest } from "./launcher-contracts.js";
import { privateJson,privateOwner,type LauncherTarget } from "./launcher-client.js";
export type LaunchMutation=Extract<LauncherRequest,{command:"launch_create"|"launch_open"}>;
export class LauncherDrafts {
  readonly directory:string;private readonly root:string;
  constructor(readonly target:Pick<LauncherTarget,"hubId"|"machineId">,root?:string){
    this.root=root??process.env.DECK_CLIENT_STATE_DIRECTORY??(process.platform==="darwin"?join(homedir(),"Library/Application Support/deck/client"):join(process.env.XDG_STATE_HOME||join(homedir(),".local/state"),"deck/client"));
    if(!isAbsolute(this.root))throw new Error("Client draft root must be absolute");
    this.directory=join(this.root,"launcher-drafts",createHash("sha256").update(JSON.stringify([target.hubId,target.machineId])).digest("hex"));
  }
  private async prepare(create=false){
    for(const path of [this.root,join(this.root,"launcher-drafts"),this.directory]){
      if(create)await mkdir(path,{recursive:true,mode:0o700});
      try{const info=await lstat(path);privateOwner(info);if(!info.isDirectory())throw new Error("Draft storage must not be a symlink");}
      catch(e){if(!create && (e as NodeJS.ErrnoException).code==="ENOENT")return false;throw e;}
    }return true;
  }
  private path(id:string){if(!validRexUuid(id))throw new Error("Invalid launcher draft ID");return join(this.directory,id+".json");}
  async load(id:string):Promise<LaunchMutation>{
    await this.prepare();const raw=await privateJson(this.path(id),256*1024) as Record<string,unknown>;
    if(!raw || raw.version!==1 || raw.hubId!==this.target.hubId || raw.machineId!==this.target.machineId || !validLaunchRequest(raw.request) || !["launch_create","launch_open"].includes(raw.request.command))throw new Error("Invalid launcher draft scope");
    const request=raw.request as LaunchMutation;if(request.args.requestId!==id)throw new Error("Draft identity mismatch");return request;
  }
  async save(request:LaunchMutation){
    if(!validLaunchRequest(request))throw new Error("Invalid launcher draft; not sent");await this.prepare(true);
    const path=this.path(request.args.requestId),tmp=join(this.directory,randomUUID()+".tmp");
    try{
      const f=await open(tmp,"wx",0o600);try{await f.writeFile(JSON.stringify({version:1,hubId:this.target.hubId,machineId:this.target.machineId,request}));await f.sync();}finally{await f.close();}
      try{await link(tmp,path);}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;if(JSON.stringify(await this.load(request.args.requestId))!==JSON.stringify(request))throw new Error("Launcher draft ID conflict");}
      const d=await open(this.directory,"r");try{await d.sync();}finally{await d.close();}
    }finally{await rm(tmp,{force:true});}
  }
  async remove(request:LaunchMutation){
    try{if(JSON.stringify(await this.load(request.args.requestId))!==JSON.stringify(request))throw new Error("Draft changed; not removed");}
    catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return;throw e;}
    await rm(this.path(request.args.requestId));
    const d=await open(this.directory,"r");try{await d.sync();}finally{await d.close();}
  }
  async list():Promise<LaunchMutation[]>{
    if(!await this.prepare())return [];const names=(await readdir(this.directory)).filter(n=>n.endsWith(".json")).sort();
    if(names.length>1000)throw new Error("Too many launcher drafts; inspect local storage");
    const items:LaunchMutation[]=[];for(const name of names){try{items.push(await this.load(name.slice(0,-5)));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}}return items;
  }
}
