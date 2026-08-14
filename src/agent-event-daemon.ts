import { timingSafeEqual } from "node:crypto";
import { AgentEventDaemon, signAgentEventIngress, type AgentEvent, type AuthenticatedAgentEventIngress, type IngressAuthority } from "./agent-event-ledger";

const SNOWFLAKE=/^[1-9]\d{16,19}$/; const TOKEN=/^[A-Za-z0-9._~+\/-]{32,4096}$/;
export type AgentEventDaemonConfig={httpToken:string;authority:IngressAuthority;storeKey:Buffer;maxBodyBytes:number};
export function loadAgentEventDaemonConfig(env:Record<string,string|undefined>):AgentEventDaemonConfig{
  const token=env.MAW_AGENT_EVENT_HTTP_TOKEN,authorId=env.MAW_AGENT_EVENT_AUTHOR_ID;
  let authority:Buffer,storeKey:Buffer;try{authority=Buffer.from(env.MAW_AGENT_EVENT_INGRESS_KEY_B64??"","base64");storeKey=Buffer.from(env.MAW_AGENT_EVENT_STORE_KEY_B64??"","base64");}catch{throw new Error("agent-event daemon configuration invalid");}
  if(!token||!TOKEN.test(token)||!authorId||!SNOWFLAKE.test(authorId)||authority.length<32||storeKey.length<32||authority.equals(Buffer.alloc(authority.length))||storeKey.equals(Buffer.alloc(storeKey.length)))throw new Error("agent-event daemon configuration invalid");
  return{httpToken:token,authority:{authorId,key:authority},storeKey,maxBodyBytes:64*1024};
}
export type TrustedDiscordRow={authorId:string;authorIsBot:boolean;channelId:string;projectRoute:string;messageId:string;timestamp:string;event:AgentEvent};
export function signTrustedDiscordRow(row:TrustedDiscordRow,authority:IngressAuthority):AuthenticatedAgentEventIngress{
  if(row.authorId!==authority.authorId||row.authorIsBot||!SNOWFLAKE.test(row.channelId)||!SNOWFLAKE.test(row.messageId))throw new Error("trusted Discord row rejected");
  const unsigned={event:row.event,authorId:row.authorId,authorIsBot:false,channelId:row.channelId,projectRoute:row.projectRoute,nonce:`discord:${row.channelId}:${row.messageId}`,issuedAt:row.timestamp};
  return{...unsigned,signature:signAgentEventIngress(unsigned,authority.key)};
}
export class AgentEventHttpIngress{
  constructor(private daemon:AgentEventDaemon,private config:AgentEventDaemonConfig){}
  async handle(request:Request):Promise<Response>{
    if(request.method!=="POST"||new URL(request.url).pathname!=="/agent-event")return new Response("not found",{status:404});
    const supplied=request.headers.get("authorization")?.replace(/^Bearer /,"")??"";
    if(supplied.length!==this.config.httpToken.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(this.config.httpToken)))return new Response("unauthorized",{status:401});
    const raw=await request.text();if(Buffer.byteLength(raw)>this.config.maxBodyBytes)return new Response("invalid",{status:400});
    let body:unknown;try{body=JSON.parse(raw);}catch{return new Response("invalid",{status:400});}
    try{const receipt=await this.daemon.ingest(body as AuthenticatedAgentEventIngress);return Response.json(receipt,{status:receipt.status==="accepted"?202:200});}catch{return new Response("rejected",{status:400});}
  }
}
