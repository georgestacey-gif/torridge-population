// Fetch latest Torridge population from ONS Beta API and write to data/data.json
// Run in GitHub Actions (Node 20+).
// Resolves CORS by fetching server-side and committing the JSON.

import fs from 'node:fs/promises';

const API_BASE = 'https://api.beta.ons.gov.uk/v1';
const LA_GSS = 'E07000046'; // Torridge
const DATASET_TITLE_RE = /Estimates of the population for England and Wales/i;

async function api(path){
  const res = await fetch(`${API_BASE}${path}`, { headers: { 'Accept': 'application/json' } });
  if(!res.ok){
    const text = await res.text().catch(()=>'');
    throw new Error(`ONS API ${res.status}: ${path} :: ${text}`);
  }
  return res.json();
}

async function run(){
  // 1) Find Population Estimates dataset id
  const search = await api(`/search?q=${encodeURIComponent('population estimates local authority')}&content_type=dataset&limit=100`);
  const ds = (search.items || [])
    .map(i => ({
      id: i?.description?.dataset_id || (i?.uri || '').split('/').pop(),
      title: i?.description?.title || '',
      latest_release: i?.description?.latest_release || ''
    }))
    .find(it => DATASET_TITLE_RE.test(it.title));

  if(!ds?.id) throw new Error('Dataset not found');

  const datasetId = ds.id;

  // 2) Latest edition
  const edResp = await api(`/datasets/${datasetId}/editions`);
  const editions = edResp.items || [];
  if(!editions.length) throw new Error('No editions');
  const latestEdition = editions
    .map(e => ({ edition: e.edition, last: Date.parse(e.last_updated || 0) || 0 }))
    .sort((a,b) => b.last - a.last)[0].edition;

  // 3) Latest version
  const verResp = await api(`/datasets/${datasetId}/editions/${encodeURIComponent(latestEdition)}/versions`);
  const versions = verResp.items || [];
  if(!versions.length) throw new Error('No versions');
  const latestVersion = versions
    .map(v => ({ version: v.version, n: Number(v.version) || 0 }))
    .sort((a,b) => b.n - a.n)[0].version;

  // Helper: find dimension option id by label predicate
  async function findOption(dim, predicate){
    const opts = await api(`/datasets/${datasetId}/editions/${encodeURIComponent(latestEdition)}/versions/${latestVersion}/dimensions/${dim}/options`);
    const it = (opts.items || []).find(predicate);
    return it && (it.option || it.id);
  }

  const sexId = await findOption('sex', o => /all\s*persons|persons/i.test(o.label));
  const ageId = await findOption('age', o => /all\s*ages/i.test(o.label));
  if(!sexId || !ageId) throw new Error('Missing sex/age options');

  // Latest time
  const timeOpts = await api(`/datasets/${datasetId}/editions/${encodeURIComponent(latestEdition)}/versions/${latestVersion}/dimensions/time/options?limit=1000`);
  const timeItems = (timeOpts.items || []).map(o => o.option || o.id).sort();
  const latestTime = timeItems[timeItems.length - 1];
  if(!latestTime) throw new Error('No time found');

  // Observation
  const obs = await api(`/datasets/${datasetId}/editions/${encodeURIComponent(latestEdition)}/versions/${latestVersion}/observations?geography=${LA_GSS}&sex=${encodeURIComponent(sexId)}&age=${encodeURIComponent(ageId)}&time=${encodeURIComponent(latestTime)}`);
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

run().catch(err => {
  console.error(err);
  process.exit(1);
});
