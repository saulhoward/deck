// Client-only launcher transport. No Harness, provider, execution store or retry.
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { createConnection } from "node:net";
import { validRemoteWorkerConfig, validLauncherScope, type LauncherRequest } from "./generated/contracts.js";
import { validRexClient } from "./remote-contracts.js";
import { validLaunchRequest, validLaunchResponse } from "./launcher-contracts.js";
import { FrameDecoder, encodeFrame } from "./protocol.js";
export type LauncherTarget={hubId:string;machineId:string;socket:string};
export function privateOwner(info:{mode:number;uid:number}) {
  if(info.uid!==process.getuid?.() || (info.mode&0o077)!==0)throw new Error("Launcher storage must be private and owned by this user");
}
export async function privateJson(path:string,limit:number):Promise<unknown> {
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const info=await file.stat();privateOwner(info);if(!info.isFile() || info.size>limit)throw new Error("Invalid launcher file");
    const bytes=Buffer.alloc(limit+1);let count=0;
    while(count<bytes.length){const r=await file.read(bytes,count,bytes.length-count,null);if(!r.bytesRead)break;count+=r.bytesRead;}
    if(count>limit)throw new Error("Launcher file exceeds limit");
    try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,count)));}catch{throw new Error("Invalid launcher JSON");}
  }finally{await file.close();}
}
export async function launcherTarget(directory:string):Promise<LauncherTarget> {
  try{
    if(!isAbsolute(directory) || /[\0\r\n]/.test(directory))throw new Error();
    const info=await lstat(directory);privateOwner(info);if(!info.isDirectory())throw new Error();
    const c=await privateJson(join(directory,"worker.json"),4096);
    if(!validRemoteWorkerConfig(c) || c.launcher!==true || !c.rexClient || !validRexClient(c.rexClient) || c.rexClient.socket!==join(directory,"client.sock") || !validLauncherScope({hubId:c.hubId}))throw new Error();
    return {hubId:c.hubId,machineId:c.machineId,socket:c.rexClient.socket};
  }catch{throw new Error("Invalid or unapproved worker launcher configuration; no connection attempted");}
}
export async function launcherCommand(target:LauncherTarget,request:LauncherRequest,signal?:AbortSignal):Promise<unknown> {
  let encoded:Buffer;
  try{
    signal?.throwIfAborted();if(!validLaunchRequest(request) || !validLauncherScope({hubId:target.hubId}) || !isAbsolute(target.socket) || Buffer.byteLength(target.socket)>100 || /[\0\r\n]/.test(target.socket))throw new Error();
    const [parent,socket]=await Promise.all([lstat(dirname(target.socket)),lstat(target.socket)]);privateOwner(parent);
    if(!parent.isDirectory() || !socket.isSocket() || socket.uid!==parent.uid)throw new Error();
    const body=JSON.stringify(request),launcher={hubId:target.hubId};encoded=encodeFrame({launcher,body});
    encodeFrame({connectionId:"a".repeat(64),id:"b".repeat(64),launcher,body});
  }catch{throw new Error("Launcher unavailable or invalid; this attempt was not sent; earlier attempts may have applied");}
  const socket=createConnection({path:target.socket}),decoder=new FrameDecoder();
  const abort=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(10000)]);
  const cancel=()=>socket.destroy(new Error("Launcher detached"));abort.addEventListener("abort",cancel,{once:true});
  socket.on("error",e=>decoder.destroy(e));socket.pipe(decoder);
  let response:unknown;
  try{
    if(abort.aborted)cancel();socket.once("connect",()=>{if(!abort.aborted)socket.write(encoded);});
    let count=0;for await(const value of decoder){if(++count!==1)throw new Error();response=value;}if(count!==1)throw new Error();
  }catch{throw new Error("Launcher link lost/cancelled; outcome unconfirmed; no request replayed");}
  finally{abort.removeEventListener("abort",cancel);socket.destroy();decoder.destroy();}
  if(!validLaunchResponse(response,request,target.hubId,target.machineId))throw new Error("Invalid launcher acknowledgement; outcome unconfirmed");
  if(!response.ok)throw new Error(response.error.message);
  return response.result;
}
