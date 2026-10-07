import http from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {timingSafeEqual} from 'node:crypto';
import {validate,messages} from './core.mjs';
const env=process.env, origin=env.ALLOWED_ORIGIN, dailyLimit=Number(env.DAILY_LIMIT||100);
const port=Number(env.PORT||8080),usagePath=env.USAGE_FILE||new URL('./usage.json',import.meta.url);
const rates=new Map();let lock=Promise.resolve();
function equal(a,b){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y)}
async function reserve(){const current=lock.then(async()=>{let saved;try{saved=JSON.parse(await readFile(usagePath,'utf8'))}catch(e){if(e.code!=='ENOENT')throw Error('用量记录不可用，暂时停止生成。');saved={}}const day=new Date().toISOString().slice(0,10);if(saved.day!==day)saved={day,count:0};if(saved.count>=dailyLimit)throw Error('今日生成额度已用完，请明日再试。');saved.count++;await writeFile(usagePath,JSON.stringify(saved));});lock=current.catch(()=>{});return current}
const server=http.createServer(async(req,res)=>{
 const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Vary':'Origin'};
 if(origin&&req.headers.origin===origin){headers['Access-Control-Allow-Origin']=origin;headers['Access-Control-Allow-Methods']='POST, OPTIONS';headers['Access-Control-Allow-Headers']='Content-Type, X-Access-Code';}
 const send=(status,data)=>{res.writeHead(status,headers);res.end(JSON.stringify(data))};
 if(req.url==='/health'&&req.method==='GET')return send(200,{ok:true,configured:!!(env.MODEL_API_KEY&&env.MODEL_NAME&&origin)});
 if(req.url!=='/api/generate')return send(404,{error:'接口不存在。'});
 if(!origin||req.headers.origin!==origin)return send(403,{error:'请求来源不匹配。'});
 if(req.method==='OPTIONS'){res.writeHead(204,headers);return res.end()}
 if(req.method!=='POST')return send(405,{error:'仅支持POST请求。'});
 if(!env.MODEL_API_KEY||!env.MODEL_NAME)return send(503,{error:'模型服务尚未配置，请联系网站维护者。'});
 if(env.ACCESS_CODE&&!equal(req.headers['x-access-code'],env.ACCESS_CODE))return send(401,{error:'体验口令不正确。'});
 // Single-instance rate limit. Do not trust client-supplied forwarding headers.
 const ip=req.socket.remoteAddress||'unknown',now=Date.now();for(const [k,v] of rates)if(now-v.at>60000)rates.delete(k);
 const rate=rates.get(ip)||{at:now,count:0};if(rate.count>=5)return send(429,{error:'请求较多，请一分钟后重试。'});rate.count++;rates.set(ip,rate);
 let size=0,chunks=[];
 try{
  for await(const chunk of req){size+=chunk.length;if(size>140000){send(413,{error:'输入内容过大。'});req.destroy();return}chunks.push(chunk)}
  let payload;try{payload=validate(JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch(e){return send(400,{error:e.message})}
  try{await reserve()}catch(e){return send(429,{error:e.message})}
  const url=new URL((env.MODEL_BASE_URL||'https://api.deepseek.com').replace(/\/$/,'')+'/chat/completions');
  if(url.protocol!=='https:')return send(503,{error:'模型服务地址必须使用HTTPS。'});
  const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+env.MODEL_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({model:env.MODEL_NAME,messages:messages(payload),max_tokens:6000,stream:false}),signal:AbortSignal.timeout(110000)});
  if(!response.ok)return send(502,{error:response.status===429?'模型服务繁忙或额度不足，请稍后再试。':'模型服务调用失败，请检查后台配置和账户额度。'});
  const data=await response.json(),choice=data.choices?.[0],text=choice?.message?.content;
  if(choice?.finish_reason==='length')return send(502,{error:'生成内容超过长度限制，请缩小主题或减少题目数量后重试。'});
  if(typeof text!=='string'||!text.trim())return send(502,{error:'模型未返回有效内容，请重试。'});
  return send(200,{text});
 }catch(e){return send(502,{error:e.name==='TimeoutError'?'模型响应超时，请稍后重试。':'暂时无法生成，请稍后再试。'})}
});server.listen(port,()=>console.log('Zhineng Xiaoyuan API listening on port '+port));
