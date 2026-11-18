import { createClient } from 'npm:@supabase/supabase-js@2.84.0';

const headers={
  'Access-Control-Allow-Origin':'https://davimarz.github.io',
  'Access-Control-Allow-Headers':'authorization, apikey, x-client-info, content-type',
  'Access-Control-Allow-Methods':'POST, OPTIONS',
  'Cache-Control':'private, max-age=300',
  'Content-Type':'application/json',
};
const reply=(status,body)=>new Response(JSON.stringify(body),{status,headers});
const finite=value=>Number.isFinite(Number(value))?Number(value):0;

Deno.serve(async req=>{
  if(req.method==='OPTIONS')return new Response(null,{status:204,headers});
  if(req.method!=='POST')return reply(405,{code:'METHOD_NOT_ALLOWED'});
  const authorization=req.headers.get('Authorization')||'';
  if(!authorization.startsWith('Bearer '))return reply(401,{code:'AUTH_REQUIRED'});
  try{
    const client=createClient(Deno.env.get('SUPABASE_URL'),Deno.env.get('SUPABASE_ANON_KEY'),{
      global:{headers:{Authorization:authorization}},auth:{persistSession:false,autoRefreshToken:false},
    });
    const {data:{user},error:authError}=await client.auth.getUser(authorization.slice(7));
    if(authError||!user)return reply(401,{code:'AUTH_REQUIRED'});
    const {data:access,error:accessError}=await client.from('admin_access').select('id').eq('id',1).maybeSingle();
    if(accessError||!access)return reply(403,{code:'ADMIN_REQUIRED'});
    const token=Deno.env.get('META_ADS_ACCESS_TOKEN');
    if(!token)return reply(503,{code:'META_NOT_CONFIGURED'});
    const input=await req.json();
    const since=new Date(input?.since),until=new Date(input?.until);
    if(!Number.isFinite(since.valueOf())||!Number.isFinite(until.valueOf())||since>=until||until>Date.now()+60000||until-since>367*86400000)return reply(400,{code:'INVALID_PERIOD'});
    const accountId=Deno.env.get('META_AD_ACCOUNT_ID')||'1621100199686666';
    const url=new URL(`https://graph.facebook.com/v27.0/act_${accountId}/insights`);
    url.search=new URLSearchParams({
      access_token:token,level:'campaign',limit:'100',
      fields:'campaign_id,campaign_name,spend,reach,impressions,inline_link_clicks,cpc,ctr,cpm,frequency,date_start,date_stop,actions',
      time_range:JSON.stringify({since:since.toISOString().slice(0,10),until:until.toISOString().slice(0,10)}),
    }).toString();
    const response=await fetch(url,{signal:AbortSignal.timeout(15000),redirect:'error'});
    const payload=await response.json();
    if(!response.ok||!Array.isArray(payload.data))return reply(response.status===401||response.status===403?502:503,{code:'META_UNAVAILABLE'});
    const campaigns=payload.data.map(row=>{
      const actions=Array.isArray(row.actions)?row.actions:[];
      const profile=actions.find(item=>/profile.*visit|landing_page_view/i.test(String(item.action_type)))?.value;
      const results=finite(profile||row.inline_link_clicks);
      const spend=finite(row.spend);
      return {campaign:row.campaign_name||row.campaign_id,channel:'Instagram',period:`${row.date_start} – ${row.date_stop}`,status:'Dati API',spend,results,reach:finite(row.reach),frequency:finite(row.frequency),impressions:finite(row.impressions),linkClicks:finite(row.inline_link_clicks),cpc:finite(row.cpc),ctr:finite(row.ctr),cpm:finite(row.cpm),costPerResult:results?spend/results:0};
    });
    return reply(200,{accountId,campaigns});
  }catch{return reply(503,{code:'META_UNAVAILABLE'});}
});
