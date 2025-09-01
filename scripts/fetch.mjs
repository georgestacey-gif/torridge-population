// Auto-detect dimension ids for sex and age
import fs from 'node:fs/promises';

const API_BASE = 'https://api.beta.ons.gov.uk/v1';
const LA_GSS = 'E07000046'; // Torridge

async function api(path){
  const res = await fetch(`${API_BASE}${path}`, { headers: { 'Accept': 'application/json' } });
  if(!res.ok){
    const text = await res.text().catch(()=>'');
    throw new Error(`ONS API ${res.status}: ${path} :: ${text}`);
  }
  return res.json();
}

function looksLikePopEst(title=''){
  const t = title.toLowerCase();
  return t.includes('population') && t.includes('estimate');
}

async function run(){
  const search = await api(`/search?q=${encodeURIComponent('population estimates')}&content_type=dataset&limit=200`);
  const items = (search.items || []).map(i => ({
    id: i?.description?.dataset_id || (i?.uri || '').split('/').pop(),
    title: i?.description?.title || ''
  }));
  let ds = items.find(i => looksLikePopEst(i.title));
  if(!ds){
    const all = await api('/datasets?limit=500');
    const list = (all.items || []).map(i => ({ id: i.id, title: i.title || i.description || '' }));
    ds = list.find(i => looksLikePopEst(i.title));
  }
  if(!ds?.id) throw new Error('Dataset not found');
  const datasetId = ds.id;
  console.log('Using dataset:', datasetId, ds.title);

  // Editions
  const edResp = await api(`/datasets/${datasetId}/editions`);
  const editions = edResp.items || [];
  if(!editions.length) throw new Error('No editions');
  const latestEdition = editions
    .map(e => ({ edition: e.edition, last: Date.parse(e.last_updated || 0) || 0 }))
    .sort((a,b) => b.last - a.last)[0].edition;

  // Versions
  const verResp = await api(`/datasets/${datasetId}/editions/${encodeURIComponent(latestEdition)}/versions`);
  const versions = verResp.items || [];
  if(!versions.length) throw new Error('No versions');
  const latestVersion = versions
    .map(v => ({ version: v.version, n: Number(v.version) || 0 }))
    .sort((a,b) => b.n - a.n)[0].version;

  // Discover dimension ids
  const dims = await api(`/datasets/${datasetId}/editions/${encodeURIComponent(latestEdition)}/versions/${latestVersion}`);
  const dimList = (dims.dimensions || []).map(d => ({ id: d.id, label: d.label?.toLowerCase() || d.id }));
  console.log('Dimensions:', dimList);

  // Guess sex/age dimension names
  const sexDim = dimList.find(d => /sex|persons/.test(d.id) || /sex|persons/.test(d.label))?.id;
  const ageDim = dimList.find(d => /age/.test(d.id) || /age/.test(d.label))?.id;
  if(!sexDim || !ageDim) throw new Error(`Could not identify sex/age dims from ${JSON.stringify(dimList)}`);

  async function findOption(dim, pattern){
    const opts = await api(`/datasets/${datasetId}/editions/${encodeURIComponent(latestEdition)}/versions/${latestVersion}/dimensions/${dim}/options?limit=1000`);
    const it = (opts.items || []).find(o => pattern.test(String(o.label).toLowerCase()));
    return it && (it.option || it.id);
  }

  const sexId = await findOption(sexDim, /all\s*persons|persons|all person/);
  const ageId = await findOption(ageDim, /all\s*ages|all ages/);
  if(!sexId || !ageId) throw new Error('Missing sex/age options');

  const timeOpts = await api(`/datasets/${datasetId}/editions/${encodeURIComponent(latestEdition)}/versions/${latestVersion}/dimensions/time/options?limit=2000`);
  const timeItems = (timeOpts.items || []).map(o => o.option || o.id).sort();
  const latestTime = timeItems[timeItems.length - 1];
  if(!latestTime) throw new Error('No time found');

  const obs = await api(`/datasets/${datasetId}/editions/${encodeURIComponent(latestEdition)}/versions/${latestVersion}/observations?geography=${LA_GSS}&${encodeURIComponent(sexDim)}=${encodeURIComponent(sexId)}&${encodeURIComponent(ageDim)}=${encodeURIComponent(ageId)}&time=${encodeURIComponent(latestTime)}`);
  const first = (obs.observations || [])[0];
  const value = first?.observation ?? first?.value;
  const periodLabel = first?.dimensions?.time?.label || latestTime;
  if(value == null) throw new Error('No observation value');

  await fs.mkdir('data', { recursive: true });
  const out = {
    geography: LA_GSS,
    population: Number(value),
    period: String(latestTime),
    period_label: String(periodLabel),
    dataset_id: datasetId,
    dataset_title: ds.title,
    updated_at: new Date().toISOString()
  };
  await fs.writeFile('data/data.json', JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log('Wrote data/data.json:', out);
}

run().catch(err => { console.error(err); process.exit(1); });
