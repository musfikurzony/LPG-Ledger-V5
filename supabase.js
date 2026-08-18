// Supabase client + data access layer. Every function here either talks to
// Supabase directly, or (when offline / a call fails) falls back to the last
// cached copy in localStorage via offline.js. This is the ONLY place that
// decides "live vs cached" — the rest of the app just calls loadStore/saveStore
// and doesn't need to know which source it got.

let sb = null;
if(SUPABASE_URL.indexOf('PASTE_')!==0 && window.supabase){
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

async function loadStore(key, shared, fallback){
  if(key.indexOf('photo:')===0) return fallback; // photos are read via photoUrl(), not this path
  if(!sb) return loadCachedAppData() || fallback;
  try{
    if(!navigator.onLine) throw new Error('offline');
    const { data, error } = await sb.from('app_state').select('data').eq('id','main').maybeSingle();
    if(error || !data) throw new Error('no live data');
    cacheAppData(data.data);
    return data.data;
  }catch(e){
    const cached = loadCachedAppData();
    if(cached) return cached;
    return fallback;
  }
}
async function saveStore(key, shared, value){
  if(!sb){ toast('Not saved — Supabase is not connected yet'); return; }
  if(!navigator.onLine){ toast('You\u2019re offline — this change will not be saved until you\u2019re back online'); return; }
  try{
    if(key.indexOf('photo:')===0){
      await uploadPhoto(key.slice(6), value);
      return;
    }
    const { error } = await sb.from('app_state').upsert({ id:'main', data:value, updated_at:new Date().toISOString() });
    if(error){ console.error('save failed', error); toast('Save failed — check Supabase setup'); return; }
    cacheAppData(value);
  }catch(e){ console.error('storage failed', e); toast('Save failed — check Supabase setup'); }
}
async function uploadPhoto(readingId, dataUrl){
  if(!sb) return;
  try{
    const blob = await (await fetch(dataUrl)).blob();
    await sb.storage.from('meter-photos').upload(readingId+'.jpg', blob, { upsert:true, contentType:'image/jpeg' });
  }catch(e){ console.error('photo upload failed', e); }
}
function photoUrl(readingId){
  if(!sb) return null;
  const { data } = sb.storage.from('meter-photos').getPublicUrl(readingId+'.jpg');
  return data ? data.publicUrl : null;
}

async function checkSession(){
  const { data } = await sb.auth.getSession();
  const session = data && data.session;
  if(!session){ AUTH_STATUS='signedout'; renderAll(); return; }

  let profile = null;
  try{
    if(!navigator.onLine) throw new Error('offline');
    let profRes = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
    profile = profRes.data;
    if(!profile){
      const name = (session.user.user_metadata && session.user.user_metadata.name) || session.user.email;
      const ins = await sb.from('profiles').insert({ id:session.user.id, name:name, email:session.user.email }).select().maybeSingle();
      profile = ins.data;
    }
    if(profile) cacheProfile(profile);
  }catch(e){
    profile = loadCachedProfile();
  }

  if(!profile || profile.role === 'pending'){ AUTH_STATUS='pending'; renderAll(); return; }
  const rawPerms = Array.isArray(profile.permissions) ? profile.permissions.slice() : [];
  // Every resident with an assigned flat automatically sees their own Flat Dashboard —
  // no need for an admin to remember to tick "My Flat" separately.
  if(profile.role === 'resident' && profile.flat_id && rawPerms.indexOf('my_flat') === -1) rawPerms.push('my_flat');
  CURRENT_USER = { id: profile.id, name: profile.name, email: profile.email, role: profile.role, flat_id: profile.flat_id || null, permissions: rawPerms };
  AUTH_STATUS = 'ready';
  DATA = await loadStore('lpg-data', true, null);
  if(!DATA){ DATA = { purchases: [], readings: [], flats: seedFlats(), settings:{ abnormalThresholdPct: 25 } }; await saveStore('lpg-data', true, DATA); }
  if(!DATA.flats || DATA.flats.length===0) DATA.flats = seedFlats();
  if(!DATA.settings) DATA.settings = { abnormalThresholdPct: 25 };
  if(DATA.settings.abnormalThresholdPct === undefined) DATA.settings.abnormalThresholdPct = 25;
  DATA.purchases.forEach(function(p){
    if(p.manualRate === undefined) p.manualRate = null;
    if(!p.cylinders){
      p.cylinders = [{ id: uid('CYL'), date: p.date || new Date().toISOString().slice(0,10), kg: p.totalKg||0, cost: p.totalCost||0, hasPhoto:false }];
      delete p.date; delete p.totalKg; delete p.totalCost;
    }
  });
  if(CURRENT_USER.role === 'resident' && CURRENT_USER.flat_id) HISTORY_FLAT = CURRENT_USER.flat_id;
  renderAll();
}

async function loadProfiles(){
  if(!sb) return;
  if(!navigator.onLine){ toast('Offline — showing cached data only, account list needs a connection'); return; }
  const res = await sb.from('profiles').select('*').order('created_at', { ascending:true });
  PROFILES = res.data || [];
  if(TAB==='admin') renderMain();
}
