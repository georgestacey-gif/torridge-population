// Auto-sum ages fallback
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

  // Discover dimensions
  const verMeta = await api(`/datasets/${datasetId}/editions/${encodeURIComponent(latestEdition)}/versions/${latestVersion}`);
  const dims = verMeta.dimensions || [];
  const dimIds = Object.fromEntries(dims.map(d => [d.label?.toLowerCase() || d.id, d.id]));
  const sexDim = dimIds['sex'] || 'sex';
  const ageDim = dimIds['age'] || dimIds['single-year-of-age'] || 'age';
  const timeDim = dimIds['time'] || dimIds['calendar-years'] || 'time';
  const geoDim = dimIds['geography'] || dimIds['administrative-geography'] || 'geography';
  console.log('Dim map:', { sexDim, ageDim, timeDim, geoDim });

  // Options helpers
  async function getOptions(dim){
    const opts = await api(`/datasets/${datasetId}/editions/${encodeURIComponent(latestEdition)}/versions/${latestVersion}/dimensions/${dim}/options?limit=5000`);
    return opts.items || [];
  }
  async function findOption(dim, pattern){
    const opts = await getOptions(dim);
    const it = opts.find(o => pattern.test(String(o.label).toLowerCase()) || pattern.test(String(o.id).toLowerCase()));
    return it && (it.option || it.id);
  }

  // Sex: prefer All persons; fallback first option
  let sexId = await findOption(sexDim, /all\\s*persons|all persons|persons|all/);
  if(!sexId){
    const opts = await getOptions(sexDim);
    sexId = (opts[0]?.option) || (opts[0]?.id);
  }

  // Time latest
  const timeOpts = await api(`/datasets/${datasetId}/editions/${encodeURIComponent(latestEdition)}/versions/${latestVersion}/dimensions/${timeDim}/options?limit=5000`);
  const timeItems = (timeOpts.items || []).map(o => o.option || o.id).sort();
  const latestTime = timeItems[timeItems.length - 1];
  if(!latestTime) throw new Error('No time found');

  // Age: try All ages, else sum all numeric ages
  let ageId = await findOption(ageDim, /all\\s*ages|all ages|total/);
  let total = null;

  if(ageId){
    // single call
    const obs = await api(`/datasets/${datasetId}/editions/${encodeURIComponent(latestEdition)}/versions/${latestVersion}/observations?${geoDim}=${LA_GSS}&${sexDim}=${encodeURIComponent(sexId)}&${ageDim}=${encodeURIComponent(ageId)}&${timeDim}=${encodeURIComponent(latestTime)}`);
    const first = (obs.observations || [])[0];
    total = first?.observation ?? first?.value;
  }else{
    // sum all ages 0..120 (numeric labels)
    const ageOpts = await getOptions(ageDim);
    const numericAges = ageOpts.filter(o => /^\\d+$/.test(String(o.label)));
    if(!numericAges.length) throw new Error('No numeric ages to sum');
    let sum = 0;
    for(const ao of numericAges){
      const aid = ao.option || ao.id;
      const obs = await api(`/datasets/${datasetId}/editions/${encodeURIComponent(latestEdition)}/versions/${latestVersion}/observations?${geoDim}=${LA_GSS}&${sexDim}=${encodeURIComponent(sexId)}&${ageDim}=${encodeURIComponent(aid)}&${timeDim}=${encodeURIComponent(latestTime)}`);
      const val = (obs.observations || [])[0]?.observation ?? (obs.observations || [])[0]?.value;
      sum += Number(val || 0);
    }
    total = sum;
  }

  if(total == null) throw new Error('No observation value');

  await fs.mkdir('data', { recursive: true });
  const out = {
    geography: LA_GSS,
    population: Number(total),
    period: String(latestTime),
    period_label: String(latestTime),
    dataset_id: datasetId,
    dataset_title: ds.title,
    updated_at: new Date().toISOString()
  };
  await fs.writeFile('data/data.json', JSON.stringify(out, null, 2) + '\\n', 'utf8');
  console.log('Wrote data/data.json:', out);
}

run().catch(err => { console.error(err); process.exit(1); });
