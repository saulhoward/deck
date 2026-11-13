// JSON.parse alone silently accepts duplicate object keys. Match the native MCP
// boundary instead; keep the original input string for hashing/retained replies.
export function parseMcpJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  let at=0, nodes=0;
  const space=()=>{while(at<text.length && /[ \t\r\n]/.test(text[at]!))at++;};
  const string=():string=>{const start=at++;while(at<text.length){const c=text[at++];if(c==='"')return text.slice(start,at);if(c==='\\')at++;}throw new Error("Invalid MCP JSON");};
  const walk=(depth:number):void=>{
    if(depth>32 || ++nodes>32768)throw new Error("MCP JSON exceeds structural bounds");
    space();const c=text[at];
    if(c==='{' || c==='[') {
      const object=c==='{' ,end=object?'}':']', keys=new Set<string>(); at++;space();
      while(text[at]!==end) {
        if(object){const key=JSON.parse(string()) as string;if(keys.has(key))throw new Error("Duplicate MCP JSON key");keys.add(key);space();at++;}
        walk(depth+1);space();if(text[at]===end)break;at++;space();
      } at++;
    } else if(c==='"')string();
    else while(at<text.length && !/[ \t\r\n,}\]]/.test(text[at]!))at++;
  };
  walk(0);space();if(at!==text.length)throw new Error("Invalid MCP JSON");return value;
}
