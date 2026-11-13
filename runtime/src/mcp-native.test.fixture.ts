// Private inherited-pipe driver, used only in isolated tests with a custom runtime.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const {PipeFiles}=await import(process.env.DECK_RUNTIME_ROOT?pathToFileURL(join(process.env.DECK_RUNTIME_ROOT,"runtime/dist/host-files.js")).href:new URL("./host-files.js",import.meta.url).href) as typeof import("./host-files.js");
import { FrameDecoder, encodeFrame } from "./protocol.js";
const args=process.argv.slice(2), host=new PipeFiles(Number(args[6]),Number(args[7]),Number(args[8]));
const controls=new Map<string,AbortController>(); const decoder=new FrameDecoder();
process.stdin.pipe(decoder).on("data",(message:unknown)=>{
  const request=message as {id:string;operation:string;args:Record<string,unknown>;machineId?:string;cwd?:string;cancel?:string};
  if(request.cancel) {controls.get(request.cancel)?.abort();return;}
  const controller=new AbortController(); controls.set(request.id,controller);
  void host.call({machineId:request.machineId??args[1]!,cwd:request.cwd??args[2]!},request.id,request.operation as any,request.args,controller.signal).then(
    result=>process.stdout.write(encodeFrame({id:request.id,result})),
    error=>process.stdout.write(encodeFrame({id:request.id,error:String(error)})),
  ).finally(()=>controls.delete(request.id));
});
process.stdin.on("end",()=>{void host.close();});
