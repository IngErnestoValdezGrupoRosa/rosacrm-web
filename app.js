'use strict';

// ─────────────────────────────────────────────────────────────────
// CONFIG — SUPABASE
// ─────────────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://fcncenjqygoygyvjgtpc.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZjbmNlbmpxeWdveWd5dmpndHBjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA0OTc0OTMsImV4cCI6MjA5NjA3MzQ5M30.pKaxmubHYu4xP3eijWZ6ZYhiyFptI3NzLalQ9tn9Zr8';
const LS_KEY     = 'rosacrm_v3';

// Inicializar cliente Supabase
const _supabase = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;
if (!_supabase) console.error('[RosaCRM] ⚠ Supabase SDK no cargado — revisa la conexión a internet');

// ── Genera un UUID v4 compatible con Supabase ──
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ── Detecta si un string es UUID válido ──
function isUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

const STAGES = [
  { id: 0, label: 'Prospección',    dot: 'bg-slate',   prob: 0.10 },
  { id: 1, label: 'Calificación',   dot: 'bg-purple',  prob: 0.25 },
  { id: 2, label: 'Descubrimiento', dot: 'bg-blue',    prob: 0.40 },
  { id: 3, label: 'Propuesta',      dot: 'bg-amber',   prob: 0.60 },
  { id: 4, label: 'Negociación',    dot: 'bg-orange',  prob: 0.75 },
  { id: 5, label: 'Cierre',         dot: 'bg-success', prob: 1.00 },
  { id: 6, label: 'Post-Venta',     dot: 'bg-cyan',    prob: 1.00 },
];

// ─────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────
let STATE = {
  clients:      [],   // desde Supabase (tabla clientes) — solo lectura
  clientExtras: {},   // {[clientId]: {email, industria, zona, notas, nombre, contacto, tel1, tel2}} — localStorage
  deals:        [],
  allDeals:     [],
  teamMode: false,
  syncStatus: 'idle',
  lastSync:   null,
  config: {
    quota:        50000,
    currency:     'MXN',
    cacMarketing: 5000,
    cacVentas:    3000,
    cacAuto:      true,
  },
  ui: {
    section:       'dashboard',
    clientSearch:  '',
    clientZone:    'all',
    clientIndustry: 'all',
    pipeSearch:    '',
    pipePriority:  'all',
    clientPage:    1,
    pageSize:      25,
    sortCol:       'ventas',
    sortDir:       'desc',
    mobileStage:   0,
  },
  auth: {
    user: null,
    session: null
  }
};

// ─────────────────────────────────────────────────────────────────
// PERSISTENCE (solo deals + config, los clientes vienen de Sheets)
// ─────────────────────────────────────────────────────────────────
function saveLocal() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      deals:        STATE.deals,
      clientExtras: STATE.clientExtras,
      config:       STATE.config,
      lastSync:     STATE.lastSync,
      clientsBackup: STATE.clients,
    }));
  } catch (e) {}
}

// ── Persistir deals en Supabase (segundo plano, no bloquea UI) ──
let _isSyncingDeals = false;
async function syncDealsToSupabase() {
  if (!_supabase || _isSyncingDeals || !STATE.auth.user) return;
  _isSyncingDeals = true;
  const currentUserId = STATE.auth.user.id;
  const currentUserName = STATE.auth.user.user_metadata?.full_name || STATE.auth.user.email.split('@')[0];
  try {
    for (const d of STATE.deals) {
      if (!isUUID(d.id)) d.id = generateUUID();
      if (!d.user_id) { d.user_id = currentUserId; d.user_name = currentUserName; }
      
      const row = {
        id:          d.id,
        titulo:      d.title || '',
        valor:       parseFloat(d.value) || 0,
        stage:       parseInt(d.stage) || 0,
        priority:    d.priority || 'medium',
        close_date:  d.closeDate || null,
        status:      (d.status === 'active' ? 'activo' : d.status) || 'activo',
        notes:       d.notes || '',
        loss_reason: d.lossReason || '',
        created_at:  d.createdAt || new Date().toISOString(),
        archived:    d.archived ? true : false,
        user_id:     d.user_id,
        user_name:   d.user_name
      };
      if (isUUID(d.clientId)) row.cliente_id = d.clientId;
      const { error } = await _supabase.from('deals').upsert(row, { onConflict: 'id' });
      if (error && error.message && error.message.includes('archived')) {
        const { archived: _, ...r2 } = row;
        await _supabase.from('deals').upsert(r2, { onConflict: 'id' });
      }
    }
    STATE.deals.forEach(d => {
      const idx = STATE.allDeals.findIndex(x => x.id === d.id);
      if (idx >= 0) STATE.allDeals[idx] = { ...d };
      else STATE.allDeals.push({ ...d });
    });
    saveLocal();
    console.log('[RosaCRM] Deals sincronizados a Supabase ✓');
  } catch (e) {
    console.warn('[RosaCRM] Error sincronizando deals a Supabase:', e.message);
  } finally {
    _isSyncingDeals = false;
  }
}


function loadLocal() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    if (s.deals)         STATE.deals        = s.deals;
    if (s.clientExtras)  STATE.clientExtras = s.clientExtras;
    if (s.config)        STATE.config       = { ...STATE.config, ...s.config };
    if (s.lastSync)      STATE.lastSync     = s.lastSync;
    // Restaurar backup de clientes mientras llega la sincronización
    if (s.clientsBackup && s.clientsBackup.length > 0) {
      STATE.clients = s.clientsBackup;
      console.log('[RosaCRM] Clientes restaurados del backup local:', STATE.clients.length);
    }
  } catch (e) {}
}

// ── Devuelve el cliente base mezclado con sus extras locales ───────
function mergedClient(c) {
  const ex = STATE.clientExtras[c.id] || {};
  return {
    ...c,
    nombre:      c.nombre      || ex.nombre,
    contacto:    c.contacto    || ex.contacto,
    telefono1:   c.telefono1   || ex.tel1,
    telefono2:   c.telefono2   || ex.tel2,
    email:       c.email       || ex.email       || '',
    industria:   c.sector      || c.industria    || ex.industria   || '',
    zona:        c.zona        || ex.zona        || '',
    descripcion: c.descripcion || ex.descripcion || '',
    clientes_de: c.clientes_de || ex.clientes_de || '',
    notas:       c.notas       || ex.notas       || '',
  };
}

// ── Busca cliente de forma robusta por ID exacto, por índice de fila (c_150) o por nombre de empresa ──
function findClient(clientId) {
  if (!clientId) return null;
  
  // 1. Buscar por ID exacto
  let client = STATE.clients.find(c => c.id === clientId);
  if (client) return client;

  // 2. Si es un ID viejo basado en índice (c_150 o client_150)
  const numericStr = String(clientId).replace('c_', '').replace('client_', '');
  const idx = parseInt(numericStr);
  if (!isNaN(idx) && STATE.clients[idx]) {
    return STATE.clients[idx];
  }

  // 3. Buscar por coincidencia de nombre/empresa
  const norm = str => String(str || '').toLowerCase().trim();
  client = STATE.clients.find(c => norm(c.nombre) === norm(clientId) || norm(c.empresa) === norm(clientId));
  if (client) return client;

  // 4. Buscar en extras locales
  const ex = STATE.clientExtras[clientId];
  if (ex) {
    return {
      id: clientId,
      nombre: ex.nombre || clientId,
      empresa: ex.nombre || clientId,
      contacto: ex.contacto || '',
      telefono1: ex.tel1 || '',
      zona: ex.zona || '',
    };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────
// INIT — los bindings van PRIMERO para que los botones funcionen
// aunque falle cualquier render o CDN
// ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadLocal();

  // Setup de Autenticación
  setupAuth();

  // 1. Bindings primero
  bindNav();
  bindHeaderButtons();
  bindFilters();
  bindModalForms();
  bindSettingsButtons();
  bindOnboarding();

  // 2. Íconos y render (Solo si hay sesión, se manejará en onAuthStateChange, pero dejamos el safeIcons aquí)
  safeIcons();
  
  // No renderizamos todo aquí, dependemos de auth state.
});

// ─────────────────────────────────────────────────────────────────
// AUTHENTICATION LOGIC
// ─────────────────────────────────────────────────────────────────
function setupAuth() {
  if (!_supabase) {
    document.getElementById('auth-error').textContent = "Supabase no está configurado correctamente.";
    document.getElementById('auth-error').classList.remove('hidden');
    return;
  }

  const authContainer = document.getElementById('auth-container');
  const mainAppContainer = document.getElementById('main-app-container');
  const splashScreen = document.getElementById('splash-screen');

  // Listener para el estado de autenticación
  _supabase.auth.onAuthStateChange((event, session) => {
    console.log('[RosaCRM] Auth event:', event);
    if (STATE.auth.session?.access_token === session?.access_token && event !== 'SIGNED_IN' && event !== 'INITIAL_SESSION') return;
    STATE.auth.session = session;
    STATE.auth.user = session?.user;
    if (session && session.user) {
      authContainer.classList.add('hidden');
      const userName = session.user.user_metadata?.full_name || session.user.email.split('@')[0];
      document.getElementById('sidebar-user-name').textContent = userName;
      document.getElementById('sidebar-user-avatar').textContent = userName.substring(0, 2).toUpperCase();
      
      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
        splashScreen.classList.remove('hidden');
        splashScreen.style.display = 'flex';
        const video = document.getElementById('splash-video');
        if(video) { video.currentTime = 0; video.play().catch(e => console.warn(e)); }
        
        setTimeout(() => {
          splashScreen.classList.add('hidden');
          splashScreen.style.display = 'none';
          mainAppContainer.classList.remove('hidden');
          syncDirectorio();
          renderAll();
          if (!STATE.config.onboardingDone) setTimeout(() => openModal('modal-onboarding'), 800);
        }, 4500);
      } else {
        splashScreen.classList.add('hidden');
        splashScreen.style.display = 'none';
        mainAppContainer.classList.remove('hidden');
        syncDirectorio();
        renderAll();
      }
    } else {
      authContainer.classList.remove('hidden');
      mainAppContainer.classList.add('hidden');
      if (splashScreen) {
        splashScreen.classList.add('hidden');
        splashScreen.style.display = 'none';
      }
    }
  });

  // Toggle Login/Registro
  let isLogin = true;
  document.getElementById('auth-toggle-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    isLogin = !isLogin;
    document.getElementById('auth-title').textContent = isLogin ? 'Bienvenido al CRM' : 'Crear Cuenta';
    document.getElementById('auth-subtitle').textContent = isLogin ? 'Inicia sesión para continuar' : 'Regístrate como nuevo usuario';
    document.getElementById('btn-auth-action').textContent = isLogin ? 'Iniciar Sesión' : 'Registrarse';
    document.getElementById('auth-toggle-prompt').textContent = isLogin ? '¿No tienes cuenta?' : '¿Ya tienes cuenta?';
    document.getElementById('auth-toggle-link').textContent = isLogin ? 'Regístrate aquí' : 'Inicia sesión';
    const nameGroup = document.getElementById('auth-name-group');
    if (nameGroup) {
      if (isLogin) {
        nameGroup.classList.add('hidden');
        document.getElementById('auth-name').removeAttribute('required');
      } else {
        nameGroup.classList.remove('hidden');
        document.getElementById('auth-name').setAttribute('required', 'true');
      }
    }
    document.getElementById('auth-error').classList.add('hidden');
    document.getElementById('auth-success').classList.add('hidden');
  });

  // Formulario de Email/Password
  document.getElementById('auth-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('auth-email').value;
    const password = document.getElementById('auth-password').value;
    const nameInput = document.getElementById('auth-name');
    const name = nameInput ? nameInput.value : '';
    const btn = document.getElementById('btn-auth-action');
    const errDiv = document.getElementById('auth-error');
    const sucDiv = document.getElementById('auth-success');
    
    errDiv.classList.add('hidden');
    sucDiv.classList.add('hidden');
    btn.disabled = true;
    btn.innerHTML = '<div class="spinner" style="width:16px;height:16px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:8px;"></div> Cargando...';

    try {
      if (isLogin) {
        const { error } = await _supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { data, error } = await _supabase.auth.signUp({ 
          email, 
          password,
          options: { data: { full_name: name } }
        });
        if (error) throw error;
        if (data.user && data.user.identities && data.user.identities.length === 0) {
           throw new Error("Este correo ya está registrado.");
        }
        if (data.session) {
          sucDiv.textContent = "Registro exitoso. Entrando a la plataforma...";
        } else {
          sucDiv.textContent = "Revisa tu correo electrónico para confirmar tu cuenta.";
        }
        sucDiv.classList.remove('hidden');
      }
    } catch (err) {
      errDiv.textContent = err.message || "Error al procesar la solicitud.";
      errDiv.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      btn.textContent = isLogin ? 'Iniciar Sesión' : 'Registrarse';
    }
  });

  // Botón de Google OAuth
  document.getElementById('btn-auth-google')?.addEventListener('click', async () => {
    try {
      const { error } = await _supabase.auth.signInWithOAuth({ provider: 'google' });
      if (error) throw error;
    } catch (err) {
      const errDiv = document.getElementById('auth-error');
      errDiv.textContent = err.message || "Error al iniciar con Google.";
      errDiv.classList.remove('hidden');
    }
  });

  // Botón de Cerrar Sesión
  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    await _supabase.auth.signOut();
  });
}

// ─────────────────────────────────────────────────────────────────
// ONBOARDING — aparece solo la primera vez
// ─────────────────────────────────────────────────────────────────
function bindOnboarding() {
  document.getElementById('btn-onboarding-start')?.addEventListener('click', () => {
    STATE.config.onboardingDone = true;
    saveLocal();
    closeModal('modal-onboarding');
    // Ir a configuración para conectar Sheets si aún no tiene clientes
    if (!STATE.clients.length) {
      navigate('configuracion');
      setTimeout(() => toast('💡 Ve a Base de Datos → Sincronizar para conectar tu Google Sheet', 'info'), 500);
    }
  });
  document.getElementById('btn-onboarding-skip')?.addEventListener('click', () => {
    STATE.config.onboardingDone = true;
    saveLocal();
    closeModal('modal-onboarding');
  });
  // Click fuera cierra
  document.getElementById('modal-onboarding')?.addEventListener('click', e => {
    if (e.target.id === 'modal-onboarding') {
      STATE.config.onboardingDone = true;
      saveLocal();
      closeModal('modal-onboarding');
    }
  });
}

// ─────────────────────────────────────────────────────────────────
// LUCIDE HELPER — llamar siempre con esta función, nunca directo
// ─────────────────────────────────────────────────────────────────
function safeIcons() {
  try {
    if (typeof lucide !== 'undefined' && typeof lucide.createIcons === 'function') {
      lucide.createIcons();
    }
  } catch (e) {
    // lucide CDN no disponible — íconos serán texto vacío, no bloquea nada
  }
}

// Las columnas se leen directamente de la base de datos Supabase, mapeo estático implementado en syncDirectorio().

// ─────────────────────────────────────────────────────────────────
// SUPABASE — Sincronización de clientes y deals
// ─────────────────────────────────────────────────────────────────
async function syncDirectorio() {
  setSyncBadge('syncing');
  showSyncWizard(false);
  console.log('[RosaCRM] Iniciando sincronización con Supabase...');

  if (!_supabase) {
    console.error('[RosaCRM] Supabase SDK no disponible');
    setSyncBadge('error');
    showSyncWizard(true);
    toast('Error: Supabase SDK no cargado. Revisa tu conexión.', 'error');
    renderAll();
    return;
  }

  try {
    // ── 1. Cargar clientes desde Supabase ──────────────────────────
    const { data: clientRows, error: clientErr } = await _supabase
      .from('clientes')
      .select('*')
      .order('nombre', { ascending: true });

    if (clientErr) throw new Error('Clientes: ' + clientErr.message);

    if (clientRows && clientRows.length > 0) {
      const incoming = clientRows.map((c, i) => ({
        id:        c.id ? String(c.id) : 'c_' + i,
        nombre:    c.nombre || c.empresa || '',
        empresa:   c.nombre || c.empresa || '',
        contacto:  c.contacto || c.owner || '',
        ventas:    parseFloat(c.ventas) || 0,
        telefono1: String(c.telefono1 || c.phone || '').trim(),
        telefono2: String(c.telefono2 || '').trim(),
        zona:      c.zona || c.zone || '',
        sector:    c.sector || c.industria || '',
      })).filter(c => c.nombre.length > 0);

      // 🛡️ PROTECCIÓN ANTI-BORRADO
      const current = STATE.clients.length;
      if (incoming.length >= Math.floor(current * 0.7) || current === 0) {
        STATE.clients = incoming;
        console.log('[RosaCRM] ✓ Clientes cargados desde Supabase:', incoming.length);
      } else {
        console.warn(`[RosaCRM] ⚠️ Supabase devolvió ${incoming.length} vs ${current} — manteniendo caché.`);
      }
    } else {
      console.log('[RosaCRM] Supabase devolvió 0 clientes — manteniendo caché local.');
    }

    // ── 2. Cargar deals desde Supabase ─────────────────────────────
    const { data: dealRows, error: dealErr } = await _supabase
      .from('deals')
      .select('*');

    if (dealErr) {
      console.warn('[RosaCRM] Error cargando deals:', dealErr.message);
    } else if (dealRows && dealRows.length > 0) {
      const incomingDeals = dealRows.map(d => ({
        id:         d.id || generateUUID(),
        clientId:   d.cliente_id || '',
        clientName: findClient(d.cliente_id)?.nombre || '',
        title:      d.titulo || 'Oportunidad',
        value:      parseFloat(d.valor) || 0,
        closeDate:  d.close_date ? String(d.close_date).split('T')[0] : '',
        status:     d.status || 'active',
        stage:      parseInt(d.stage) || 0,
        priority:   d.priority || 'medium',
        notes:      d.notes || '',
        lossReason: d.loss_reason || '',
        createdAt:  d.created_at || new Date().toISOString(),
        closedAt:   d.closed_at || null,
        archived:   d.archived || false,
        user_id:    d.user_id || '',
        user_name:  d.user_name || ''
      }));
      // Mantener deals locales que aún no existen en Supabase (creados offline/errores de sync)
      const localOnly = STATE.allDeals.filter(ld => !incomingDeals.find(id => id.id === ld.id));
      STATE.allDeals = [...incomingDeals, ...localOnly];
      
      if(window.applyTeamModeFilter) applyTeamModeFilter(); else STATE.deals = STATE.allDeals;
      console.log('[RosaCRM] 📦 Deals cargados desde Supabase (merged con locales):', STATE.allDeals.length);
    }

    STATE.lastSync = new Date().toISOString();
    saveLocal();
    setSyncBadge('ok');
    showSyncWizard(false);
    populateZoneFilter();
    renderAll();
    toast(`✓ ${STATE.clients.length} clientes sincronizados desde Supabase`, 'success');

  } catch (err) {
    console.error('[RosaCRM] ✗ Error sincronizando con Supabase:', err.message);
    setSyncBadge('error');
    showSyncWizard(true);
    toast('Error al conectar con Supabase — usando caché local.', 'warning');
    renderAll();
  }
}

// ─────────────────────────────────────────────────────────────────
// SYNC BADGE
// ─────────────────────────────────────────────────────────────────
function setSyncBadge(status) {
  STATE.syncStatus = status;
  const badge = document.getElementById('sync-status-badge');
  if (!badge) return;
  const map = {
    syncing: ['badge-warning', '⟳ Sincronizando...'],
    ok:      ['badge-success', '✓ Sincronizado'],
    error:   ['badge-danger',  '✗ Sin conexión'],
  };
  const [cls, txt] = map[status] || ['badge-muted', '—'];
  badge.className = 'badge ' + cls;
  badge.textContent = txt;
}

function showSyncWizard(show) {
  document.getElementById('sync-wizard')?.classList.toggle('hidden', !show);
}

// ─────────────────────────────────────────────────────────────────
// NAVIGATION
// ─────────────────────────────────────────────────────────────────
function bindNav() {
  document.querySelectorAll('.nav-item[data-target]').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.target));
  });
}

function navigate(section) {
  STATE.ui.section = section;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.target === section));
  document.querySelectorAll('.content-section').forEach(s => s.classList.toggle('active', s.id === 'section-' + section));
  const titles = {
    dashboard:     ['Reporte Directivo',   'Análisis de tu pipeline y cartera de clientes'],
    pipeline:      ['Pipeline de Ventas',   'Arrastra y gestiona tus negocios por etapa'],
    clientes:      ['Cartera de Clientes', `${STATE.clients.length} clientes · sincronizado con Supabase`],
    configuracion: ['Base de Datos',        'Configuración y Sincronización'],
    rutas:         ['Rutas y Mapas',        'Visualiza la ubicación de tus clientes y planifica rutas'],
  };
  const [t, s] = titles[section] || ['RosaCRM', ''];
  setText('page-title', t);
  setText('page-subtitle', s);

  // Show/hide header buttons per section
  document.querySelectorAll('.header-section-btn').forEach(btn => {
    btn.style.display = (btn.dataset.section === section) ? '' : 'none';
  });

  if (section === 'dashboard') {
    renderDashboard();
  } else if (section === 'pipeline') {
    renderPipeline();
  } else if (section === 'clientes') {
    renderClients();
  } else if (section === 'configuracion') {
    syncConfigUI();
  } else if (section === 'rutas') {
    setTimeout(() => { if (window.initRutasMap) window.initRutasMap(); }, 200);
  }

  safeIcons();
}

// ─────────────────────────────────────────────────────────────────
// HEADER BUTTONS
// ─────────────────────────────────────────────────────────────────
function bindHeaderButtons() {
  document.getElementById('btn-quick-deal')?.addEventListener('click', () => openDealModal(null));
  
  // El botón '+ Agregar Cliente' abre la búsqueda rápida de clientes
  const openQuickSearch = () => {
    setValue('quick-client-search-input', '');
    renderQuickSearchResults('');
    openModal('modal-quick-client-search');
    setTimeout(() => document.getElementById('quick-client-search-input')?.focus(), 150);
  };
  
  document.getElementById('btn-quick-client')?.addEventListener('click', openQuickSearch);
  document.getElementById('btn-tab-add-client')?.addEventListener('click', openQuickSearch);

  // Escuchar inputs en el buscador rápido de clientes
  document.getElementById('quick-client-search-input')?.addEventListener('input', e => {
    renderQuickSearchResults(e.target.value);
  });
  document.getElementById('modal-quick-client-close')?.addEventListener('click', () => {
    closeModal('modal-quick-client-search');
  });

  // Toggle panel de notificaciones
  const bellBtn = document.getElementById('btn-notifications-bell');
  const panel = document.getElementById('notifications-panel');
  bellBtn?.addEventListener('click', e => {
    e.stopPropagation();
    panel?.classList.toggle('hidden');
  });
  
  document.getElementById('btn-clear-notifications')?.addEventListener('click', e => {
    panel?.classList.add('hidden');
  });
  
  // Cerrar al hacer click fuera
  document.addEventListener('click', e => {
    if (panel && !panel.classList.contains('hidden') && !panel.contains(e.target) && e.target !== bellBtn) {
      panel.classList.add('hidden');
    }
  });
}

// ─────────────────────────────────────────────────────────────────
// RENDER PRINCIPAL
// ─────────────────────────────────────────────────────────────────
function renderAll() {
  renderDashboard();
  renderPipeline();
  renderClients();
  syncConfigUI();
  renderNotifications();
  safeIcons();
}

// ─────────────────────────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────────────────────────
function renderDashboard() {
  const deals   = STATE.deals;
  const clients = STATE.clients;

  // Segmentos de deals
  const active  = deals.filter(d => d.stage < 5);
  const won     = deals.filter(d => d.stage === 5 && d.status === 'ganado');
  const lost    = deals.filter(d => d.stage === 5 && d.status === 'perdido');
  const closed  = [...won, ...lost];

  // ── KPI: Forecast ponderado (Animado)
  const forecast = active.reduce((s, d) => s + (d.value || 0) * STAGES[d.stage].prob, 0);
  animateValue('kpi-forecast', 0, forecast, 1200, fmt);
  setText('kpi-forecast-sub', `${active.length} negocio(s) activo(s) en pipeline`);

  // ── KPI: Tasa de conversión (Animado)
  const convRate = closed.length > 0 ? parseFloat(((won.length / closed.length) * 100).toFixed(1)) : 0;
  animateValue('kpi-conversion', 0, convRate, 1200, v => v.toFixed(1) + '%');

  // ── KPI: Ticket promedio (Animado)
  const wonTotal = won.reduce((s, d) => s + (d.value || 0), 0);
  const avgTicket = won.length > 0 ? wonTotal / won.length : 0;
  animateValue('kpi-ticket', 0, avgTicket, 1200, fmt);

  // ── KPI: Ciclo de ventas (Animado)
  const cycles = won
    .filter(d => d.createdAt && d.closedAt)
    .map(d => Math.round((new Date(d.closedAt) - new Date(d.createdAt)) / 86400000));
  const avgCycle = cycles.length ? Math.round(cycles.reduce((a, b) => a + b, 0) / cycles.length) : 0;
  animateValue('kpi-cycle', 0, avgCycle, 1200, v => Math.floor(v) + ' días');

  // ── KPI: Cumplimiento de cuota (Animado)
  const quota    = STATE.config.quota;
  const quotaPct = quota > 0 ? Math.min(parseFloat(((wonTotal / quota) * 100).toFixed(1)), 999) : 0;
  animateValue('kpi-quota', 0, quotaPct, 1200, v => v.toFixed(1) + '%');
  setText('kpi-quota-sub', `Meta: ${fmt(quota)}  ·  Logrado: ${fmt(wonTotal)}`);

  // ── KPI: CAC
  calcAndShowCAC();

  // ── Cards de resumen de Directorio
  renderDirectorioSummary(clients, deals);

  // ── Charts
  renderChartPipeline();
  renderChartWinLoss();
}

function renderDirectorioSummary(clients, deals) {
  const totalVentas  = clients.reduce((s, c) => s + c.ventas, 0);
  const topClient    = [...clients].sort((a, b) => b.ventas - a.ventas)[0];
  const zonas        = [...new Set(clients.map(c => c.zona).filter(Boolean))];
  const clientsWDeal = new Set(deals.map(d => d.clientId)).size;

  animateValue('stat-total-clients', 0, clients.length, 1000);
  animateValue('stat-ventas-hist', 0, totalVentas, 1200, fmt);
  setText('stat-top-client',     topClient?.nombre  || '—');
  animateValue('stat-top-value', 0, topClient ? topClient.ventas : 0, 1200, fmt);
  setText('stat-zonas',          zonas.length || '—');
  setText('stat-clients-w-deal', clientsWDeal || 0);
}

function calcAndShowCAC() {
  const marketing  = parseFloat($v('cac-marketing'))  || STATE.config.cacMarketing;
  const ventas     = parseFloat($v('cac-ventas'))     || STATE.config.cacVentas;
  const auto       = document.getElementById('cac-auto-clientes')?.checked ?? STATE.config.cacAuto;
  const wonCount   = auto
    ? STATE.deals.filter(d => d.stage === 5 && d.status === 'ganado').length
    : parseFloat($v('cac-nuevos-clientes')) || 1;
  const cac = wonCount > 0 ? (marketing + ventas) / wonCount : 0;
  setText('kpi-cac', fmt(cac));
  setText('kpi-cac-sub', `${wonCount} cliente(s) nuevos este período`);
  const inp = document.getElementById('cac-nuevos-clientes');
  if (inp) { inp.value = wonCount; inp.disabled = auto; }
}

function renderChartPipeline() {
  if (typeof Chart === 'undefined') return;
  const canvas = document.getElementById('chart-pipeline');
  if (!canvas) return;
  if (canvas._ch) { canvas._ch.destroy(); }

  const data = STAGES.slice(0, 5).map(s => ({
    label: s.label,
    count: STATE.deals.filter(d => d.stage === s.id).length,
    value: STATE.deals.filter(d => d.stage === s.id).reduce((s2, d) => s2 + (d.value || 0), 0),
  }));

  const ctx = canvas.getContext('2d');
  const colors = ['#64748b', '#8b5cf6', '#3b82f6', '#f59e0b', '#f97316'];
  
  // Generar gradientes lineales premium
  const bgGradients = colors.map(color => {
    const grad = ctx.createLinearGradient(0, 0, 0, 260);
    grad.addColorStop(0, color);
    grad.addColorStop(1, color + '15'); // Transparencia elegante en el fondo
    return grad;
  });

  canvas._ch = new Chart(ctx, {
    type: 'bar',
    data: {
      labels:   data.map(d => d.label),
      datasets: [{
        label:           'Negocios',
        data:            data.map(d => d.count),
        backgroundColor: bgGradients,
        borderColor:     colors,
        borderWidth:     2,
        borderRadius:    6,
        borderSkipped: false
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 1500,
        easing: 'easeOutQuart'
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => ` ${c.parsed.y} negocio(s) · ${fmt(data[c.dataIndex].value)}` } },
      },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#64748b', font: { size: 11, weight: '600' } } },
        y: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#64748b', stepSize: 1, font: { size: 11 } }, beginAtZero: true },
      },
    },
  });
}

function renderChartWinLoss() {
  if (typeof Chart === 'undefined') return;
  const canvas = document.getElementById('chart-win-loss');
  if (!canvas) return;
  if (canvas._ch) { canvas._ch.destroy(); }

  const won    = STATE.deals.filter(d => d.stage === 5 && d.status === 'ganado').length;
  const lost   = STATE.deals.filter(d => d.stage === 5 && d.status === 'perdido').length;
  const active = STATE.deals.filter(d => d.stage < 5).length;

  const ctx = canvas.getContext('2d');
  
  // Gradientes premium para dona
  const gradWon = ctx.createLinearGradient(0, 0, 0, 200);
  gradWon.addColorStop(0, '#10b981');
  gradWon.addColorStop(1, '#059669');

  const gradLost = ctx.createLinearGradient(0, 0, 0, 200);
  gradLost.addColorStop(0, '#ef4444');
  gradLost.addColorStop(1, '#dc2626');

  const gradActive = ctx.createLinearGradient(0, 0, 0, 200);
  gradActive.addColorStop(0, '#6366f1');
  gradActive.addColorStop(1, '#4f46e5');

  canvas._ch = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels:   ['Ganados', 'Perdidos', 'En curso'],
      datasets: [{
        data:            [won || 0, lost || 0, active || 0],
        backgroundColor: [gradWon, gradLost, gradActive],
        borderColor:     ['rgba(16,185,129,0.2)', 'rgba(239,68,68,0.2)', 'rgba(99,102,241,0.2)'],
        borderWidth:     1,
        hoverOffset: 6
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '72%',
      animation: {
        duration: 1500,
        easing: 'easeOutQuart'
      },
      plugins: {
        legend: { position: 'bottom', labels: { color: '#94a3b8', font: { size: 11, weight: '600' }, padding: 14 } },
        tooltip: { callbacks: { label: c => ` ${c.label}: ${c.parsed}` } },
      },
    },
  });
}

// ─────────────────────────────────────────────────────────────────
// PIPELINE KANBAN
// ─────────────────────────────────────────────────────────────────
function renderPipeline() {
  const search   = STATE.ui.pipeSearch.toLowerCase();
  const priority = STATE.ui.pipePriority;

  // Excluir archivados del Kanban activo
  const filtered = STATE.deals.filter(d => {
    if (d.archived) return false;
    const client = findClient(d.clientId);
    const contactName = client?.contacto || '';
    const ms = !search 
      || (d.title || '').toLowerCase().includes(search) 
      || (d.clientName || '').toLowerCase().includes(search)
      || contactName.toLowerCase().includes(search);
    const mp = priority === 'all' || d.priority === priority;
    return ms && mp;
  });

  // Stats del pipeline (solo no-archivados activos)
  const active = STATE.deals.filter(d => !d.archived && d.stage < 5);
  setText('pipeline-total-deals', active.length);
  setText('pipeline-total-value', fmt(active.reduce((s, d) => s + (d.value || 0), 0)));

  STAGES.forEach(stage => {
    const container = document.getElementById(`stage-${stage.id}-cards`);
    const countEl   = document.querySelector(`[data-stage="${stage.id}"] .column-count`);
    const valueEl   = document.querySelector(`[data-stage="${stage.id}"] .column-subvalue`);
    if (!container) return;

    const stageDeals = filtered.filter(d => d.stage === stage.id);
    const stageVal   = stageDeals.reduce((s, d) => s + (d.value || 0), 0);

    const colEl = document.querySelector(`[data-stage="${stage.id}"]`);
    if (colEl) colEl.classList.toggle('active-mobile', stage.id === (STATE.ui.mobileStage || 0));

    if (countEl) countEl.textContent = stageDeals.length;
    if (valueEl) valueEl.textContent = stageDeals.length ? fmt(stageVal) : '$0';

    if (!stageDeals.length) {
      container.innerHTML = `<div class="empty-state" style="padding:18px 8px;font-size:12px"><p>Sin negocios</p></div>`;
      return;
    }

    container.innerHTML = stageDeals.map(deal => {
      const prioCls = { high: 'priority-high', medium: 'priority-medium', low: 'priority-low' }[deal.priority] || 'priority-medium';
      const closedTag = deal.stage === 5
        ? `<span class="badge ${deal.status === 'ganado' ? 'badge-success' : 'badge-danger'}" style="font-size:10px;margin-bottom:6px">
             ${deal.status === 'ganado' ? '✓ Ganado' : '✗ Perdido'}
           </span>`
        : '';
      // Buscar datos del cliente para mostrar empresa Y contacto por separado
      const clientData = findClient(deal.clientId);
      const mc         = clientData ? mergedClient(clientData) : null;
      const empresa    = mc?.empresa  || mc?.nombre || deal.clientName || '—';
      // Clean contacto: show only name, strip emails
      let rawContacto = mc?.contacto || '';
      rawContacto = rawContacto.replace(/\([^)]*@[^)]*\)/g, '').replace(/\s*;\s*/g, ', ').trim();
      if (rawContacto.includes('@')) rawContacto = rawContacto.split(/[;,]/).filter(p => !p.includes('@')).join(', ').trim();
      const contacto = rawContacto || '';

      return `
        <div class="kanban-card"
             draggable="true"
             data-deal-id="${deal.id}"
             ondragstart="handleDragStart(event,'${deal.id}')"
             ondragend="handleDragEnd(event)"
             onclick="openDealModal('${deal.id}')">
          <div class="drag-handle" title="Arrastrar">⠿</div>
          <div class="card-title">${esc(deal.title)}</div>
          <div class="card-company">
            <span class="card-empresa">${esc(empresa)}</span>
            ${contacto ? `<span class="card-contacto"><i data-lucide="user" style="width:10px;height:10px;vertical-align:middle;"></i> ${esc(contacto)}</span>` : ''}
          </div>
          ${STATE.ui.teamMode && deal.user_name ? `<div style="margin-top:4px"><span class="badge badge-warning" style="font-size:10px"><i data-lucide="shield" style="width:10px;height:10px;vertical-align:middle;"></i> ${esc(deal.user_name)}</span></div>` : ''}
          ${closedTag}
          <div class="card-footer">
            <span class="card-value">${fmt(deal.value)}</span>
            <span class="card-date">${deal.closeDate ? fmtDate(deal.closeDate) : '—'}</span>
            <span class="card-priority ${prioCls}"></span>
          </div>
          <div class="card-actions">
            <button class="btn btn-calendar btn-sm" onclick="event.stopPropagation();addToCalendar('${deal.id}')">
              <i data-lucide="calendar-plus"></i> Calendar
            </button>
          </div>
        </div>`;
    }).join('');
  });

  initDragDrop();   // re-inicializar listeners en columnas tras cada render
  safeIcons();

  // Renderizar sección de archivados al final del pipeline
  renderArchivedDeals();
}

// ─────────────────────────────────────────────────────────────────
// DRAG & DROP — HTML5 nativo, sin librerías externas
// ─────────────────────────────────────────────────────────────────
let _dragDealId = null;   // ID del deal siendo arrastrado

window.handleDragStart = (e, dealId) => {
  _dragDealId = dealId;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dealId);
  setTimeout(() => e.target.classList.add('dragging'), 0);
  // Mostrar bote de basura siempre
  document.getElementById('trash-dropzone')?.classList.remove('hidden');
  // Mostrar caja de archivo solo si es Cierre (stage 5)
  const deal = STATE.deals.find(d => d.id === dealId);
  if (deal && deal.stage === 5) {
    const az = document.getElementById('archive-dropzone');
    if (az) az.style.display = 'flex';
  }
};

window.handleDragEnd = (e) => {
  e.target.classList.remove('dragging');
  // Ocultar bote basura
  document.getElementById('trash-dropzone')?.classList.add('hidden');
  document.getElementById('trash-dropzone')?.classList.remove('dragover');
  // Ocultar caja de archivo
  const az = document.getElementById('archive-dropzone');
  if (az) { az.style.display = 'none'; az.classList.remove('dragover'); }
};

function initDragDrop() {
  // Configuración del bote de basura (Trash Zone)
  const trash = document.getElementById('trash-dropzone');
  if (trash && !trash._trashInit) {
    trash._trashInit = true;
    trash.addEventListener('dragover', e => {
      e.preventDefault();
      trash.classList.add('dragover');
    });
    trash.addEventListener('dragleave', () => {
      trash.classList.remove('dragover');
    });
    trash.addEventListener('drop', e => {
      e.preventDefault();
      trash.classList.remove('dragover');
      const dealId = e.dataTransfer.getData('text/plain') || _dragDealId;
      if (dealId) {
        if (confirm('¿Deseas eliminar este negocio permanentemente del pipeline?')) {
          deleteDeal(dealId);
        }
      }
      trash.classList.add('hidden');
    });
  }

  // Configuración de la caja de archivo (Archive Zone)
  const archZone = document.getElementById('archive-dropzone');
  if (archZone && !archZone._archiveInit) {
    archZone._archiveInit = true;
    archZone.addEventListener('dragover', e => {
      e.preventDefault();
      archZone.style.transform = 'scale(1.35)';
      archZone.style.background = 'rgba(196,127,40,0.35)';
      archZone.style.borderStyle = 'solid';
      archZone.style.borderColor = '#e8952e';
      archZone.style.boxShadow = '0 0 30px rgba(196,127,40,0.85)';
    });
    archZone.addEventListener('dragleave', () => {
      archZone.style.transform = '';
      archZone.style.background = 'rgba(161,100,35,0.13)';
      archZone.style.borderStyle = 'dashed';
      archZone.style.borderColor = '#c47f28';
      archZone.style.boxShadow = '0 0 15px rgba(196,127,40,0.35)';
    });
    archZone.addEventListener('drop', e => {
      e.preventDefault();
      archZone.style.transform = '';
      archZone.style.display = 'none';
      const dealId = e.dataTransfer.getData('text/plain') || _dragDealId;
      if (dealId) { archiveDeal(dealId); }
    });
  }

  document.querySelectorAll('.kanban-cards-container').forEach(container => {
    // Evitar duplicar listeners con flag
    if (container._ddInit) return;
    container._ddInit = true;

    container.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      container.classList.add('drag-over');
    });

    container.addEventListener('dragleave', e => {
      // Solo quitar clase si salimos completamente del contenedor
      if (!container.contains(e.relatedTarget)) {
        container.classList.remove('drag-over');
      }
    });

    container.addEventListener('drop', e => {
      e.preventDefault();
      container.classList.remove('drag-over');
      const dealId  = e.dataTransfer.getData('text/plain') || _dragDealId;
      const colEl   = container.closest('.kanban-column');
      const newStage = parseInt(colEl?.dataset.stage ?? -1);
      if (dealId && newStage >= 0) handleCardDrop(dealId, newStage);
    });
  });
}

function handleCardDrop(dealId, newStage) {
  const deal = STATE.deals.find(d => d.id === dealId);
  if (!deal) return;

  // Quitar clase dragging del elemento original
  document.querySelector(`[data-deal-id="${dealId}"]`)?.classList.remove('dragging');

  const prevStage = deal.stage;
  if (prevStage === newStage) return;   // sin cambio — no hacer nada

  // Actualizar stage en STATE
  deal.stage = newStage;

  // Si llega a Cierre, marcar como activo (el usuario decidirá ganado/perdido)
  if (newStage === 5 && (deal.status === 'active' || deal.status === 'activo')) {
    deal.status = 'ganado';   // default optimista — editable al abrir la tarjeta
  }
  // Si sale de Cierre, resetear estado
  if (prevStage === 5 && newStage !== 5) {
    deal.status = 'active';
    deal.closedAt = null;
  }
  // Si llega a etapa 5, registrar fecha de cierre
  if (newStage === 5) {
    deal.closedAt = deal.closedAt || new Date().toISOString();
  }

  saveLocal();
  syncDealsToSupabase();   // Persistir en Supabase
  renderPipeline();
  renderDashboard();

  // Obj 3: Mostrar opción de calendario en toast
  autoCalendarToast(deal, prevStage, newStage);
}

// ─────────────────────────────────────────────────────────────────
// CARTERA DE CLIENTES
// ─────────────────────────────────────────────────────────────────
function renderClients() {
  const search = STATE.ui.clientSearch.toLowerCase();
  const zone     = STATE.ui.clientZone;
  const industry = STATE.ui.clientIndustry;
  const { sortCol, sortDir, clientPage, pageSize } = STATE.ui;

  let list = STATE.clients.filter(c => {
    const ms = !search
      || c.nombre.toLowerCase().includes(search)
      || (c.contacto  || '').toLowerCase().includes(search)
      || (c.zona      || '').toLowerCase().includes(search)
      || (c.sector    || '').toLowerCase().includes(search)
      || (c.telefono1 || '').includes(search);
    // Zone filter now uses geolocation (N/S/E/O)
    const clientZone = getClientGeoZone(c.id);
    const mz = zone === 'all' || clientZone === zone;
    const mi = industry === 'all' || (c.sector || '').toLowerCase() === industry.toLowerCase();
    return ms && mz && mi;
  });

  // Ordenar
  list.sort((a, b) => {
    const va = a[sortCol] ?? '', vb = b[sortCol] ?? '';
    if (typeof va === 'number') return sortDir === 'asc' ? va - vb : vb - va;
    return sortDir === 'asc' ? String(va).localeCompare(String(vb), 'es') : String(vb).localeCompare(String(va), 'es');
  });

  const total      = list.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page       = Math.min(clientPage, totalPages);
  STATE.ui.clientPage = page;
  const paged = list.slice((page - 1) * pageSize, page * pageSize);

  const tbody = document.getElementById('clients-table-body');
  if (!tbody) return;

  if (!STATE.clients.length) {
    tbody.innerHTML = `<tr><td colspan="6">
      <div class="loading-state"><div class="spinner"></div><span>Cargando desde Supabase...</span></div>
    </td></tr>`;
    return;
  }

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="6">
      <div class="empty-state"><i data-lucide="search-x"></i><p>Sin resultados para "${esc(search)}"</p></div>
    </td></tr>`;
    safeIcons();
    return;
  }

  tbody.innerHTML = paged.map(c => {
    const mc = mergedClient(c);   // incluye extras locales
    const activeDeals = STATE.deals.filter(d => d.clientId === c.id && d.stage < 5).length;
    const tel = mc.telefono1
      ? `<a href="tel:${esc(mc.telefono1)}" style="color:var(--accent-cyan)">${esc(mc.telefono1)}</a>`
      : (mc.telefono2 ? `<a href="tel:${esc(mc.telefono2)}" style="color:var(--accent-cyan)">${esc(mc.telefono2)}</a>` : '—');

    const dealBadge = activeDeals > 0
      ? `<span class="badge badge-warning">${activeDeals} en pipeline</span>`
      : '';

    // Badge de sector con color según tipo
    const sectorColor = {
      'automotriz': '#f97316',  // naranja
      'maquila':    '#8b5cf6',  // morado
      'integrador': '#06b6d4',  // cian
    }[(mc.sector || '').toLowerCase()] || '#64748b';
    const sectorBadge = mc.sector
      ? `<span class="badge" style="background:${sectorColor}22;color:${sectorColor};border:1px solid ${sectorColor}44;font-size:10px;">${esc(mc.sector)}</span>`
      : '';

    // Empresa y contacto — siempre separados
    const empresaCell = `<span class="client-name-cell" title="${esc(mc.empresa || mc.nombre)}">${esc(mc.empresa || mc.nombre)}</span>`;
    const contactoCell = mc.contacto
      ? `<div class="contact-person-cell"><i data-lucide="user" style="width:11px;height:11px;opacity:.6"></i> ${esc(mc.contacto)}</div>`
      : '<span class="text-muted">—</span>';

    return `
      <tr>
        <td>${empresaCell}${sectorBadge ? '<br>' + sectorBadge : ''}</td>
        <td class="muted-cell">${contactoCell}</td>
        <td class="muted-cell" style="font-size:12px">${tel}</td>
        <td>${mc.zona ? `<span class="badge badge-muted">${esc(mc.zona)}</span>` : '—'}</td>
        <td class="value-cell">${fmt(c.ventas)}</td>
        <td>
          <div class="client-row-actions">
            ${dealBadge}
            <button class="btn btn-secondary btn-sm" onclick="openClientDetail('${c.id}')">
              <i data-lucide="eye"></i>
            </button>
            <button class="btn btn-primary btn-sm" onclick="openDealModal(null,'${c.id}')">
              <i data-lucide="plus"></i> Negocio
            </button>
          </div>
        </td>
      </tr>`;
  }).join('');

  renderPagination(page, totalPages, total);
  safeIcons();
}

function renderPagination(page, totalPages, total) {
  let el = document.getElementById('clients-pagination');
  if (!el) {
    el = document.createElement('div');
    el.id = 'clients-pagination';
    el.className = 'pagination';
    document.querySelector('.table-container')?.after(el);
  }

  if (totalPages <= 1) { el.innerHTML = `<span class="page-info">${total} clientes</span>`; return; }

  let html = `<button class="page-btn" onclick="goPage(${page - 1})" ${page === 1 ? 'disabled' : ''}>‹</button>`;
  for (let i = 1; i <= totalPages; i++) {
    if (totalPages > 10 && Math.abs(i - page) > 2 && i !== 1 && i !== totalPages) {
      if (i === page - 3 || i === page + 3) html += `<span class="page-info">…</span>`;
      continue;
    }
    html += `<button class="page-btn ${i === page ? 'active' : ''}" onclick="goPage(${i})">${i}</button>`;
  }
  html += `<button class="page-btn" onclick="goPage(${page + 1})" ${page === totalPages ? 'disabled' : ''}>›</button>`;
  html += `<span class="page-info">${total} clientes</span>`;
  el.innerHTML = html;
}

window.goPage = p => {
  STATE.ui.clientPage = p;
  renderClients();
};

function populateZoneFilter() {
  // Zone filter is now static (Norte/Sur/Este/Oeste) — no dynamic population needed
  // Only populate Industry filter
  const selInd = document.getElementById('client-filter-industry');
  if (selInd) {
    const industries = [...new Set(STATE.clients.map(c => c.sector).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
    const current = selInd.value;
    selInd.innerHTML = `<option value="all">Todas las Industrias</option>` + industries.map(i => `<option value="${esc(i.toUpperCase())}">${esc(i.toUpperCase())}</option>`).join('');
    if (industries.includes(current)) selInd.value = current;
  }
}

// Helper: classify a client into N/S/E/O based on geolocation
function getClientGeoZone(clientId) {
  const extras = STATE.clientExtras[clientId] || {};
  if (!extras.lat || !extras.lng) return null;
  const CHIH = { lat: 28.6330, lng: -106.0691 };
  let zone = extras.lat > CHIH.lat ? 'Norte' : 'Sur';
  if (Math.abs(extras.lng - CHIH.lng) > Math.abs(extras.lat - CHIH.lat)) {
    zone = extras.lng > CHIH.lng ? 'Este' : 'Oeste';
  }
  return zone;
}

// ─────────────────────────────────────────────────────────────────
// MODAL — DETALLE CLIENTE
// ─────────────────────────────────────────────────────────────────
window.openClientDetail = id => {
  const base = STATE.clients.find(x => x.id === id);
  if (!base) return;
  const c = mergedClient(base);   // combina Sheets + extras locales

  const clientDeals = STATE.deals.filter(d => d.clientId === id);
  const wonVal      = clientDeals.filter(d => d.stage === 5 && d.status === 'ganado').reduce((s, d) => s + (d.value || 0), 0);
  const activeCount = clientDeals.filter(d => d.stage < 5).length;

  setText('det-company-name', c.nombre);
  const tagInd = document.querySelector('.tag-industry');
  if (tagInd) tagInd.textContent = c.industria || c.zona || 'Sin industria';
  setText('det-owner',  c.contacto  || '—');
  setText('det-zone',   c.zona      || '—');
  setText('det-brands', c.telefono1 || c.telefono2 || '—');

  const phoneEl = document.getElementById('det-phone');
  if (phoneEl) {
    phoneEl.textContent = c.telefono1 || c.telefono2 || '—';
    phoneEl.href = c.telefono1 ? `tel:${c.telefono1}` : '#';
  }
  const emailEl = document.getElementById('det-email');
  if (emailEl) {
    if (c.email) {
      emailEl.textContent = c.email;
      emailEl.href = `mailto:${c.email}`;
      emailEl.style.color = 'var(--accent-primary)';
    } else {
      emailEl.textContent = '—';
      emailEl.href = '#';
    }
  }

  setText('det-desc',         c.descripcion || c.notas || 'Sin notas registradas');
  setText('det-customers',    c.clientes_de || '—');
  setText('det-total-bought', fmt(base.ventas + wonVal));
  setText('det-active-deals', activeCount);

  const hist = document.getElementById('det-deals-list');
  if (hist) {
    hist.innerHTML = clientDeals.length
      ? clientDeals.map(d => `
          <div class="history-item">
            <div>
              <div class="deal-name">${esc(d.title)}</div>
              <div class="deal-stage">${STAGES[d.stage]?.label || '—'}</div>
            </div>
            <div class="deal-val">${fmt(d.value)}</div>
          </div>`).join('')
      : `<div class="empty-state" style="padding:12px"><p>Sin negocios registrados</p></div>`;
  }

  // ── CORRECCIÓN: "Editar Expediente" → modal correcto ──────────────
  document.getElementById('btn-edit-client-from-detail')?.addEventListener('click', () => {
    closeModal('modal-client-detail');
    openClientEditModal(id);   // ← función correcta
  }, { once: true });

  // ── Inline edit: toggle and auto-save ──────────────
  const descField = document.getElementById('edit-inline-desc');
  const custField = document.getElementById('edit-inline-customers');
  if (descField) descField.value = c.descripcion || '';
  if (custField) custField.value = c.clientes_de || '';
  // Hide both edit fields initially
  descField?.classList.add('hidden');
  custField?.classList.add('hidden');
  document.getElementById('det-desc')?.classList.remove('hidden');
  document.getElementById('det-customers')?.classList.remove('hidden');

  // Auto-save on blur
  const saveInline = () => {
    if (!STATE.clientExtras[id]) STATE.clientExtras[id] = {};
    STATE.clientExtras[id].descripcion = descField?.value?.trim() || '';
    STATE.clientExtras[id].clientes_de = custField?.value?.trim() || '';
    saveLocal();
    // Update display text
    setText('det-desc', STATE.clientExtras[id].descripcion || 'Sin notas registradas');
    setText('det-customers', STATE.clientExtras[id].clientes_de || '—');
  };
  descField?.addEventListener('blur', saveInline);
  custField?.addEventListener('blur', saveInline);

  openModal('modal-client-detail');
  safeIcons();
};

// Toggle inline edit fields in client detail
window.toggleInlineEdit = (displayId, editId) => {
  const displayEl = document.getElementById(displayId);
  const editEl = document.getElementById(editId);
  if (!displayEl || !editEl) return;
  
  const isEditing = !editEl.classList.contains('hidden');
  if (isEditing) {
    // Save and close
    editEl.classList.add('hidden');
    displayEl.classList.remove('hidden');
    editEl.dispatchEvent(new Event('blur'));
  } else {
    // Open edit
    displayEl.classList.add('hidden');
    editEl.classList.remove('hidden');
    editEl.focus();
  }
  safeIcons();
};

// ─────────────────────────────────────────────────────────────────
// MODAL — EDITAR EXPEDIENTE DE CLIENTE
// ─────────────────────────────────────────────────────────────────
window.openClientEditModal = id => {
  const base = STATE.clients.find(x => x.id === id);
  if (!base) { toast('Cliente no encontrado', 'error'); return; }
  const c = mergedClient(base);

  // Rellenar campos con datos actuales (Sheets + extras)
  setValue('edit-client-id',       c.id);
  setValue('edit-client-nombre',   c.nombre);
  setValue('edit-client-contacto', c.contacto);
  setValue('edit-client-tel1',     c.telefono1);
  setValue('edit-client-tel2',     c.telefono2);
  setValue('edit-client-email',    c.email);
  setValue('edit-client-industria',c.industria);
  setValue('edit-client-zona',     c.zona);
  setValue('edit-client-ventas',   base.ventas);   // solo lectura — valor real de Sheets
  setValue('edit-client-descripcion', c.descripcion);
  setValue('edit-client-clientes', c.clientes_de);
  setValue('edit-client-notas',    c.notas);

  // Rellenar datalist de zonas con las que ya existen
  const dlZonas = document.getElementById('list-zonas-edit');
  if (dlZonas) {
    const zonas = [...new Set(STATE.clients.map(x => x.zona).filter(Boolean))].sort();
    dlZonas.innerHTML = zonas.map(z => `<option value="${esc(z)}">`).join('');
  }

  setText('modal-edit-client-title', `Editar: ${c.nombre}`);
  openModal('modal-edit-client');
  safeIcons();
};

// ─────────────────────────────────────────────────────────────────
// MODAL — DEAL (crear / editar)
// ─────────────────────────────────────────────────────────────────
window.openDealModal = (dealId = null, preClientId = null) => {
  const deal = dealId ? STATE.deals.find(d => d.id === dealId) : null;
  document.getElementById('form-deal')?.reset();

  // Llenar selector de clientes
  const sel = document.getElementById('deal-client-id');
  if (sel) {
    const sorted = [...STATE.clients].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    sel.innerHTML = `<option value="">-- Seleccionar Cliente --</option>`
      + sorted.map(c => `<option value="${c.id}" ${(deal?.clientId === c.id || preClientId === c.id) ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('');
  }

  // Cargar contacto del cliente seleccionado
  const selectedClientId = deal?.clientId || preClientId || '';
  const clientObj = findClient(selectedClientId);
  setValue('deal-client-contact', clientObj?.contacto || '');

  // Valores del deal
  setValue('deal-id',          deal?.id           || '');
  setValue('deal-title',       deal?.title        || '');
  setValue('deal-value',       deal?.value        || '');
  setValue('deal-stage',       deal?.stage        ?? 0);
  setValue('deal-priority',    deal?.priority      || 'medium');
  setValue('deal-close-date',  deal?.closeDate    || '');
  setValue('deal-notes',       deal?.notes        || '');
  setValue('deal-status',      deal?.status       || 'ganado');
  setValue('deal-loss-reason', deal?.lossReason   || '');

  // Fila de cierre condicional
  const stageNum = parseInt($v('deal-stage'));
  document.getElementById('cierre-status-row')?.classList.toggle('hidden', stageNum !== 5);
  document.getElementById('deal-stage').onchange = e =>
    document.getElementById('cierre-status-row')?.classList.toggle('hidden', parseInt(e.target.value) !== 5);

  // Botón eliminar
  const delBtn = document.getElementById('btn-delete-deal');
  if (delBtn) {
    delBtn.style.display = deal ? 'inline-flex' : 'none';
    delBtn.onclick = () => {
      if (confirm('¿Eliminar este negocio?')) { deleteDeal(deal.id); closeModal('modal-deal'); }
    };
  }

  // Botón Archivar — solo visible para deals en Cierre (stage 5) no archivados
  const arcBtn = document.getElementById('btn-archive-deal');
  if (arcBtn) {
    const showArc = deal && deal.stage === 5 && !deal.archived;
    arcBtn.style.display = showArc ? 'inline-flex' : 'none';
    arcBtn.onclick = () => {
      if (confirm('¿Archivar este negocio? Seguirá contando en el Dashboard pero desaparecerá del tablero Kanban.')) {
        archiveDeal(deal.id);
      }
    };
  }

  setText('modal-deal-title', deal ? 'Editar Negocio' : 'Nuevo Negocio');
  openModal('modal-deal');
  safeIcons();
};

function deleteDeal(id) {
  STATE.deals = STATE.deals.filter(d => d.id !== id);
  saveLocal();
  // Eliminar también de Supabase
  if (_supabase) {
    _supabase.from('deals').delete().eq('id', id)
      .then(({ error }) => { if (error) console.warn('[RosaCRM] Error eliminando deal de Supabase:', error.message); });
  }
  renderAll();
  toast('Negocio eliminado', 'warning');
}

// ─────────────────────────────────────────────────────────────────
// ARCHIVAR DEAL — oculta del Kanban activo pero sigue en stats
// ─────────────────────────────────────────────────────────────────
// Confirmación de archivo — llamada desde botón de tarjeta
window.confirmArchive = (id) => {
  if (confirm('¿Archivar este negocio? Seguirá contando en reportes pero saldrá del tablero Kanban.')) {
    archiveDeal(id);
  }
};

window.archiveDeal = (id) => {
  const deal = STATE.deals.find(d => d.id === id);
  if (!deal) return;
  deal.archived = true;
  saveLocal();
  syncDealsToSupabase();
  closeModal('modal-deal');
  renderAll();
  toast('✓ Negocio archivado — sigue contando en reportes', 'success');
};

window.unarchiveDeal = (id) => {
  const deal = STATE.deals.find(d => d.id === id);
  if (!deal) return;
  deal.archived = false;
  saveLocal();
  syncDealsToSupabase();
  renderAll();
  toast('↩ Negocio restaurado al Pipeline', 'info');
};

// ─────────────────────────────────────────────────────────────────
// RENDER ARCHIVADOS — sección debajo del Kanban
// ─────────────────────────────────────────────────────────────────
function renderArchivedDeals() {
  const container = document.getElementById('archived-deals-container');
  const section   = document.getElementById('archived-deals-section');
  if (!container || !section) return;

  const archived = STATE.deals.filter(d => d.archived);

  if (!archived.length) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');

  const countEl = document.getElementById('archived-count');
  const wonArc  = archived.filter(d => d.status === 'ganado');
  const lostArc = archived.filter(d => d.status === 'perdido');
  if (countEl) countEl.textContent = archived.length;

  container.innerHTML = archived.map(deal => {
    const isWon = deal.status === 'ganado';
    const clientData = findClient(deal.clientId);
    const mc = clientData ? mergedClient(clientData) : null;
    const empresa  = mc?.empresa || mc?.nombre || deal.clientName || '—';
    const contacto = mc?.contacto || '';
    return `
      <div class="archived-card ${isWon ? 'archived-won' : 'archived-lost'}">
        <div class="archived-card-header">
          <span class="archived-badge ${isWon ? 'arc-won' : 'arc-lost'}">
            ${isWon ? '✓ Ganado' : '✗ Perdido'}
          </span>
          <span class="archived-date">${deal.closeDate ? fmtDate(deal.closeDate) : '—'}</span>
        </div>
        <div class="archived-card-body">
          <div class="archived-title">${esc(deal.title)}</div>
          <div class="archived-company">${esc(empresa)}${contacto ? ` · ${esc(contacto)}` : ''}</div>
        </div>
        <div class="archived-card-footer">
          <span class="archived-value">${fmt(deal.value)}</span>
          <div class="archived-actions">
            <button class="btn btn-sm btn-ghost" onclick="unarchiveDeal('${deal.id}')" title="Restaurar al pipeline">
              <i data-lucide="rotate-ccw"></i> Restaurar
            </button>
            <button class="btn btn-sm btn-danger-ghost" onclick="if(confirm('¿Eliminar permanentemente?')) deleteDeal('${deal.id}')" title="Eliminar">
              <i data-lucide="trash-2"></i>
            </button>
          </div>
        </div>
      </div>`;
  }).join('');

  // Stats del archivo
  const statsEl = document.getElementById('archived-stats');
  if (statsEl) {
    const wonVal  = wonArc.reduce((s, d) => s + (d.value || 0), 0);
    const lostVal = lostArc.reduce((s, d) => s + (d.value || 0), 0);
    statsEl.innerHTML = `
      <span class="badge badge-success">✓ ${wonArc.length} Ganados · ${fmt(wonVal)}</span>
      <span class="badge badge-danger">✗ ${lostArc.length} Perdidos · ${fmt(lostVal)}</span>
    `;
  }

  safeIcons();
}

// ─────────────────────────────────────────────────────────────────
// BIND FORMS & MODALS
// ─────────────────────────────────────────────────────────────────
function bindModalForms() {
  // Submit deal
  document.getElementById('form-deal')?.addEventListener('submit', e => {
    e.preventDefault();
    const id       = $v('deal-id');
    const clientId = $v('deal-client-id');
    const stage    = parseInt($v('deal-stage'));

    if (!clientId) { toast('Selecciona un cliente', 'warning'); return; }

    const clientName = findClient(clientId)?.nombre || '';
    let titleStr = $v('deal-title').trim();
    if (!titleStr) {
      titleStr = 'Negocio - ' + clientName;
    }

    let rawVal = $v('deal-value').trim();
    let val = parseFloat(rawVal);
    if (rawVal && isNaN(val)) {
      toast('Por favor ingresa un valor numérico válido para el negocio.', 'error');
      return;
    }
    val = val || 0;

    const existingDeal = id ? STATE.deals.find(d => d.id === id) : null;
    const deal = {
      id:         id || generateUUID(),
      title:      titleStr,
      value:      val,
      clientId,
      clientName: clientName,
      stage,
      priority:   $v('deal-priority'),
      closeDate:  $v('deal-close-date'),
      notes:      $v('deal-notes').trim(),
      status:     stage === 5 ? $v('deal-status') : 'active',
      lossReason: $v('deal-loss-reason'),
      createdAt:  existingDeal?.createdAt || new Date().toISOString(),
      closedAt:   stage === 5 ? new Date().toISOString() : null,
      archived:   existingDeal?.archived || false,
    };

    if (id) {
      STATE.deals = STATE.deals.map(d => d.id === id ? deal : d);
      toast('Negocio actualizado ✓', 'success');
    } else {
      STATE.deals.push(deal);
      toast('Negocio creado ✓', 'success');
    }

    saveLocal();
    syncDealsToSupabase();   // Persistir en Supabase
    closeModal('modal-deal');
    renderAll();
  });

  // Escuchar cambio de cliente en modal-deal para autocompletar contacto
  document.getElementById('deal-client-id')?.addEventListener('change', e => {
    const selectedClientId = e.target.value;
    const clientObj = findClient(selectedClientId);
    setValue('deal-client-contact', clientObj?.contacto || '—');
  });

  // Botón para crear cliente sobre la marcha desde el modal del negocio
  let _openedFromFly = false;
  document.getElementById('btn-create-client-on-fly')?.addEventListener('click', () => {
    _openedFromFly = true;
    document.getElementById('form-client')?.reset();
    setValue('client-id', '');
    setText('modal-client-title', 'Crear Cliente Rápido');
    closeModal('modal-deal');
    openModal('modal-client');
  });

  // Submit form creación de cliente nuevo
  document.getElementById('form-client')?.addEventListener('submit', e => {
    e.preventDefault();
    const name = $v('client-name').trim();
    const owner = $v('client-owner').trim();
    if (!name) { toast('Agrega un nombre de empresa', 'warning'); return; }

    const id = generateUUID();
    const newClient = {
      id:        id,
      nombre:    name,
      empresa:   name,
      contacto:  owner || '—',
      telefono1: $v('client-phone').trim(),
      telefono2: '',
      zona:      $v('client-zone').trim(),
      ventas:    0
    };

    STATE.clients.push(newClient);

    // Guardar los datos extendidos (email, industria, notas, etc.) en clientExtras
    STATE.clientExtras[id] = {
      nombre:    name,
      contacto:  owner || undefined,
      tel1:      $v('client-phone').trim() || undefined,
      email:     $v('client-email').trim() || undefined,
      industria: $v('client-industry').trim() || undefined,
      zona:      $v('client-zone').trim() || undefined,
      notas:     $v('client-desc').trim() || undefined,
    };

    saveLocal();
    closeModal('modal-client');
    renderAll();
    // Persistir nuevo cliente en Supabase
    if (_supabase) {
      _supabase.from('clientes').upsert({
        id:        id,
        nombre:    name,
        contacto:  owner || '',
        telefono1: $v('client-phone').trim() || '',
        telefono2: '',
        zona:      $v('client-zone').trim() || '',
        sector:    $v('client-industry').trim() || '',
        ventas:    0,
      }, { onConflict: 'id' }).then(({ error }) => {
        if (error) console.warn('[RosaCRM] Error guardando cliente en Supabase:', error.message);
      });
    }
    toast('Cliente creado y sincronizado ✓', 'success');

    if (_openedFromFly) {
      _openedFromFly = false;
      // Reabrir el modal de negocio pre-seleccionando el nuevo cliente
      setTimeout(() => {
        openDealModal(null, id);
      }, 350);
    }
  });

  // Submit form edición de cliente
  document.getElementById('form-edit-client')?.addEventListener('submit', e => {
    e.preventDefault();
    const id = $v('edit-client-id');
    if (!id) return;

    STATE.clientExtras[id] = {
      nombre:      $v('edit-client-nombre').trim(),
      contacto:    $v('edit-client-contacto').trim(),
      tel1:        $v('edit-client-tel1').trim(),
      tel2:        $v('edit-client-tel2').trim(),
      email:       $v('edit-client-email').trim(),
      industria:   $v('edit-client-industria').trim(),
      zona:        $v('edit-client-zona').trim(),
      descripcion: $v('edit-client-descripcion').trim(),
      clientes_de: $v('edit-client-clientes').trim(),
      notas:       $v('edit-client-notas').trim(),
    };

    saveLocal();
    // Persistir cambios en Supabase
    if (_supabase) {
      const extras = STATE.clientExtras[id] || {};
      _supabase.from('clientes').update({
        nombre:    extras.nombre   || undefined,
        contacto:  extras.contacto || undefined,
        telefono1: extras.tel1     || undefined,
        telefono2: extras.tel2     || undefined,
        zona:      extras.zona     || undefined,
        sector:    extras.industria || undefined,
      }).eq('id', id).then(({ error }) => {
        if (error) console.warn('[RosaCRM] Error actualizando cliente en Supabase:', error.message);
      });
    }
    closeModal('modal-edit-client');
    renderAll();
    toast('Expediente actualizado ✓', 'success');
  });

  // Cierres de modales
  [
    ['modal-deal-close',          'modal-deal'],
    ['modal-deal-cancel',         'modal-deal'],
    ['modal-client-close',        'modal-client'],
    ['modal-client-cancel',       'modal-client'],
    ['modal-client-detail-close', 'modal-client-detail'],
    ['modal-client-detail-ok',    'modal-client-detail'],
    ['modal-edit-client-close',   'modal-edit-client'],
    ['modal-edit-client-cancel',  'modal-edit-client'],
  ].forEach(([btnId, modalId]) => {
    document.getElementById(btnId)?.addEventListener('click', () => closeModal(modalId));
  });

  // Click fuera del modal (Bloqueado para formularios críticos para evitar pérdida de datos accidental)
  document.querySelectorAll('.modal').forEach(m =>
    m.addEventListener('click', e => { 
      if (e.target === m && m.id !== 'modal-edit-client' && m.id !== 'modal-deal') {
        closeModal(m.id); 
      }
    })
  );
}

// Utility function for debouncing inputs
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// ─────────────────────────────────────────────────────────────────
// FILTERS
// ─────────────────────────────────────────────────────────────────
function bindFilters() {
  // Cartera
  document.getElementById('client-search')?.addEventListener('input', debounce(e => {
    STATE.ui.clientSearch = e.target.value;
    STATE.ui.clientPage   = 1;
    renderClients();
  }, 300));
  document.getElementById('client-filter-zone')?.addEventListener('change', e => {
    STATE.ui.clientZone = e.target.value;
    STATE.ui.clientPage = 1;
    renderClients();
  });
  document.getElementById('client-filter-industry')?.addEventListener('change', e => {
    STATE.ui.clientIndustry = e.target.value;
    STATE.ui.clientPage = 1;
    renderClients();
  });

  // Ordenar por cabeceras (data-sort)
  document.querySelectorAll('.data-table th[data-sort]').forEach(th => {
    th.style.cursor = 'pointer';
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (STATE.ui.sortCol === col) STATE.ui.sortDir = STATE.ui.sortDir === 'asc' ? 'desc' : 'asc';
      else { STATE.ui.sortCol = col; STATE.ui.sortDir = 'desc'; }
      renderClients();
    });
  });

  // Pipeline
  document.getElementById('pipeline-filter-search')?.addEventListener('input', debounce(e => {
    STATE.ui.pipeSearch = e.target.value;
    renderPipeline();
  }, 300));
  document.getElementById('pipeline-filter-priority')?.addEventListener('change', e => {
    STATE.ui.pipePriority = e.target.value;
    renderPipeline();
  });

  const btnPersonal = document.getElementById('btn-view-personal');
  const btnTeam = document.getElementById('btn-view-team');
  if (btnPersonal && btnTeam) {
    btnPersonal.addEventListener('click', () => {
      STATE.ui.teamMode = false;
      btnPersonal.classList.add('active');
      btnPersonal.style.background = 'var(--accent-primary)';
      btnPersonal.style.color = 'white';
      btnTeam.classList.remove('active');
      btnTeam.style.background = 'transparent';
      btnTeam.style.color = 'var(--text-muted)';
      if(window.applyTeamModeFilter) applyTeamModeFilter();
      renderAll();
    });
    btnTeam.addEventListener('click', () => {
      STATE.ui.teamMode = true;
      btnTeam.classList.add('active');
      btnTeam.style.background = 'var(--accent-primary)';
      btnTeam.style.color = 'white';
      btnPersonal.classList.remove('active');
      btnPersonal.style.background = 'transparent';
      btnPersonal.style.color = 'var(--text-muted)';
      if(window.applyTeamModeFilter) applyTeamModeFilter();
      renderAll();
    });
  }

  // Selector de etapas móvil
  document.querySelectorAll('.stage-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.stage-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      STATE.ui.mobileStage = parseInt(tab.dataset.stage) || 0;
      renderPipeline();
    });
  });
}

// ─────────────────────────────────────────────────────────────────
// SETTINGS BUTTONS
// ─────────────────────────────────────────────────────────────────
function bindSettingsButtons() {
  // Sync manual con Supabase
  document.getElementById('btn-sync-pipeline-now')?.addEventListener('click', async () => {
    await syncDirectorio();
  });

  // CAC inputs
  ['cac-marketing', 'cac-ventas', 'cac-nuevos-clientes', 'cac-auto-clientes'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => {
      STATE.config.cacMarketing = parseFloat($v('cac-marketing')) || 0;
      STATE.config.cacVentas    = parseFloat($v('cac-ventas'))    || 0;
      STATE.config.cacAuto      = document.getElementById('cac-auto-clientes')?.checked ?? true;
      saveLocal();
      calcAndShowCAC();
    });
  });

  // Quota / moneda
  document.getElementById('config-quota')?.addEventListener('change', e => {
    STATE.config.quota = parseFloat(e.target.value) || 50000;
    saveLocal(); renderDashboard();
  });
  document.getElementById('config-currency')?.addEventListener('change', e => {
    STATE.config.currency = e.target.value;
    saveLocal(); renderAll();
  });

  // Export / Import / Reset
  document.getElementById('btn-export-clients-csv')?.addEventListener('click', exportClientsCSV);
  document.getElementById('btn-export-pipeline-csv')?.addEventListener('click', exportPipelineCSV);
  document.getElementById('btn-export-backup')?.addEventListener('click',      exportBackup);
  document.getElementById('import-backup-file')?.addEventListener('change',    importBackup);
  document.getElementById('btn-load-samples')?.addEventListener('click',       loadSampleDeals);
  document.getElementById('btn-reset-db')?.addEventListener('click',           resetDeals);
}

function syncConfigUI() {
  setValue('cac-marketing',       STATE.config.cacMarketing);
  setValue('cac-ventas',          STATE.config.cacVentas);
  setValue('config-quota',        STATE.config.quota);
  setValue('config-currency',     STATE.config.currency);
  const autoEl = document.getElementById('cac-auto-clientes');
  if (autoEl) autoEl.checked = STATE.config.cacAuto;
}

// ─────────────────────────────────────────────────────────────────
// CALENDAR SYNC — se dispara al soltar una tarjeta en nueva etapa
// ─────────────────────────────────────────────────────────────────
function autoCalendarToast(deal, prevStage, newStage) {
  const prev    = STAGES[prevStage]?.label || prevStage;
  const current = STAGES[newStage]?.label  || newStage;

  // Construir URL de Google Calendar con etapa actualizada
  const title   = encodeURIComponent(`[RosaCRM] ${deal.title} — ${deal.clientName}`);
  const details = encodeURIComponent(
    `Negocio movido: ${deal.title}\n` +
    `Cliente: ${deal.clientName}\n` +
    `Etapa anterior: ${prev}\n` +
    `Nueva etapa: ${current}\n` +
    `Valor: ${fmt(deal.value)}\n` +
    (deal.notes ? `Notas: ${deal.notes}` : '')
  );
  const dateStr = deal.closeDate ? deal.closeDate.replace(/-/g, '') : todayStr();
  const calUrl  = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${dateStr}/${dateStr}&details=${details}`;

  // Toast especial con botón de calendario embebido
  const isCierre = newStage === 5;
  const icon     = isCierre ? '🎉' : '↗';
  const msg      = isCierre
    ? `${icon} <strong>${esc(deal.clientName)}</strong> llegó a <strong>Cierre</strong>`
    : `${icon} <strong>${esc(deal.title)}</strong>: ${esc(prev)} → <strong>${esc(current)}</strong>`;

  const container = document.getElementById('toast-container');
  if (!container) return;

  const el = document.createElement('div');
  el.className = `toast toast-${isCierre ? 'success' : 'info'} animate-slide-up toast-action`;
  el.innerHTML = `
    <span class="toast-icon"><i data-lucide="${isCierre ? 'trophy' : 'move-right'}"></i></span>
    <span class="toast-msg">${msg}</span>
    <button class="btn btn-calendar btn-sm toast-cal-btn"
            onclick="window.open('${calUrl}','_blank');this.closest('.toast').remove();">
      <i data-lucide="calendar-plus"></i> +Calendar
    </button>`;
  container.appendChild(el);
  safeIcons();
  setTimeout(() => { el.classList.add('toast-exit'); setTimeout(() => el.remove(), 300); }, 8000);
}

// -----------------------------------------------------------------
// GOOGLE CALENDAR INTEGRATION
// -----------------------------------------------------------------
window.addToCalendar = dealId => {
  const deal = STATE.deals.find(d => d.id === dealId);
  if (!deal) return;

  const title   = encodeURIComponent(`[RosaCRM] ${deal.title} — ${deal.clientName}`);
  const details = encodeURIComponent(
    `Negocio: ${deal.title}\nCliente: ${deal.clientName}\nEtapa: ${STAGES[deal.stage]?.label}\n` +
    `Valor: ${fmt(deal.value)}\nNotas: ${deal.notes || '—'}`
  );
  const dateStr = deal.closeDate ? deal.closeDate.replace(/-/g, '') : todayStr();
  const url     = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${dateStr}/${dateStr}&details=${details}`;
  window.open(url, '_blank');
  toast('Abriendo Google Calendar ✓', 'info');
};

// -----------------------------------------------------------------
// EXPORT / IMPORT / RESET
// -----------------------------------------------------------------
function exportClientsCSV() {
  if (!STATE.clients.length) { toast('No hay clientes cargados', 'warning'); return; }
  const headers = ['Empresa', 'Contacto', 'Ventas Acumuladas', 'Teléfono 1', 'Teléfono 2', 'Zona'];
  const rows    = STATE.clients.map(c =>
    [c.empresa || c.nombre, c.contacto, c.ventas, c.telefono1, c.telefono2, c.zona]
      .map(v => `"${String(v || '').replace(/"/g, '""')}"`)
      .join(',')
  );
  downloadFile([headers.join(','), ...rows].join('\n'), 'directorio_rosacrm.csv', 'text/csv');
  toast(`${STATE.clients.length} clientes exportados`, 'success');
}

function exportPipelineCSV() {
  if (!STATE.deals.length) { toast('No hay negocios en el pipeline', 'warning'); return; }
  const headers = ['Concepto Negocio', 'Cliente/Empresa', 'Valor', 'Etapa', 'Prioridad', 'Fecha Estimada Cierre', 'Estatus', 'Notas'];
  const rows = STATE.deals.map(d => {
    const client = STATE.clients.find(c => c.id === d.clientId);
    const clientName = client?.nombre || d.clientName || '—';
    const stageName = STAGES[d.stage]?.label || '—';
    const priorityName = { high: 'Alta', medium: 'Media', low: 'Baja' }[d.priority] || 'Media';
    const statusName = d.stage === 5 ? (d.status === 'ganado' ? 'Ganado' : 'Perdido') : 'Activo';
    return [
      d.title,
      clientName,
      d.value,
      stageName,
      priorityName,
      d.closeDate || '—',
      statusName,
      d.notes || ''
    ].map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',');
  });
  downloadFile([headers.join(','), ...rows].join('\n'), 'pipeline_rosacrm.csv', 'text/csv');
  toast(`${STATE.deals.length} negocios exportados`, 'success');
}

function exportBackup() {
  const data = JSON.stringify({ deals: STATE.deals, config: STATE.config, exportedAt: new Date().toISOString() }, null, 2);
  downloadFile(data, `rosacrm_backup_${todayStr()}.json`, 'application/json');
  toast('Respaldo descargado ✓', 'success');
}

function importBackup(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);
      if (data.deals)  STATE.deals  = data.deals;
      if (data.config) STATE.config = { ...STATE.config, ...data.config };
      saveLocal();
      renderAll();
      toast(`Respaldo restaurado — ${STATE.deals.length} negocios`, 'success');
    } catch { toast('Archivo de respaldo inválido', 'error'); }
  };
  reader.readAsText(file);
  e.target.value = '';
}

function loadSampleDeals() {
  if (!confirm('¿Cargar negocios de ejemplo? Se agregarán a tu pipeline actual.')) return;
  const c0 = STATE.clients[0], c1 = STATE.clients[1], c2 = STATE.clients[2];
  const samples = [
    { id:'smp1', title:'Horno Industrial XR-500',  value:50000, clientId:c0?.id||'', clientName:c0?.nombre||'Demo', stage:3, priority:'high',   notes:'Cliente requiere cotización formal', closeDate:'2026-06-30', status:'active', createdAt:new Date().toISOString(), closedAt:null },
    { id:'smp2', title:'Sistema de Control PLC',   value:28000, clientId:c1?.id||'', clientName:c1?.nombre||'Demo', stage:1, priority:'medium', notes:'Reunión inicial realizada',          closeDate:'2026-07-15', status:'active', createdAt:new Date().toISOString(), closedAt:null },
    { id:'smp3', title:'Proyecto Scanner SAFRAN',  value:15000, clientId:c2?.id||'', clientName:c2?.nombre||'Demo', stage:5, priority:'high',   notes:'Cerrado exitosamente',              closeDate:'2026-05-10', status:'ganado', createdAt:new Date(Date.now()-20*864e5).toISOString(), closedAt:new Date().toISOString() },
  ];
  samples.forEach(s => { if (!STATE.deals.find(d => d.id === s.id)) STATE.deals.push(s); });
  saveLocal();
  renderAll();
  toast('3 negocios de ejemplo cargados', 'info');
}

function resetDeals() {
  if (!confirm('¿Eliminar TODOS los negocios del pipeline? Esta acción no se puede deshacer.')) return;
  STATE.deals = [];
  saveLocal();
  renderAll();
  toast('Pipeline reiniciado', 'warning');
}

// -----------------------------------------------------------------
// MODAL HELPERS
// -----------------------------------------------------------------
function openModal(id)  { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }

// -----------------------------------------------------------------
// TOAST
// -----------------------------------------------------------------
function toast(msg, type = 'info') {
  const iconMap = { success:'check-circle', error:'x-circle', warning:'alert-triangle', info:'info' };
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type} animate-slide-up`;
  el.innerHTML = `<span class="toast-icon"><i data-lucide="${iconMap[type] || 'info'}"></i></span><span>${msg}</span>`;
  container.appendChild(el);
  safeIcons();
  setTimeout(() => { el.classList.add('toast-exit'); setTimeout(() => el.remove(), 300); }, 4500);
}

// -----------------------------------------------------------------
// UTILIDADES
// -----------------------------------------------------------------
function fmt(val) {
  const n    = parseFloat(val) || 0;
  const curr = STATE.config.currency || 'MXN';
  const locs = { MXN:'es-MX', USD:'en-US', EUR:'de-DE' };
  return new Intl.NumberFormat(locs[curr] || 'es-MX', {
    style:'currency', currency:curr, minimumFractionDigits:0, maximumFractionDigits:0,
  }).format(n);
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val ?? '';
}

function setValue(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val ?? '';
}

function $v(id) { return document.getElementById(id)?.value || ''; }

function esc(str) {
  return String(str || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtDate(dateStr) {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr + 'T12:00:00').toLocaleDateString('es-MX', { day:'2-digit', month:'short', year:'2-digit' });
  } catch { return dateStr; }
}

function todayStr() { return new Date().toISOString().split('T')[0].replace(/-/g, ''); }

function downloadFile(content, filename, mime) {
  const a = Object.assign(document.createElement('a'), {
    href:     URL.createObjectURL(new Blob([content], { type: mime })),
    download: filename,
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

// ─────────────────────────────────────────────────────────────────
// ENGINE DE NOTIFICACIONES E INSIGHTS COMERCIALES
// ─────────────────────────────────────────────────────────────────
function animateValue(id, start, end, duration, formatFn) {
  const obj = document.getElementById(id);
  if (!obj) return;
  let startTimestamp = null;
  const step = (timestamp) => {
    if (!startTimestamp) startTimestamp = timestamp;
    const progress = Math.min((timestamp - startTimestamp) / duration, 1);
    // easeOutQuad curve
    const easeProgress = progress * (2 - progress);
    const value = start + easeProgress * (end - start);
    obj.innerHTML = formatFn ? formatFn(value) : Math.floor(value);
    if (progress < 1) {
      window.requestAnimationFrame(step);
    }
  };
  window.requestAnimationFrame(step);
}

function renderNotifications() {
  const listEl = document.getElementById('notifications-list');
  const countEl = document.getElementById('bell-notifications-count');
  if (!listEl) return;

  const alerts = [];
  const hoy = new Date();

  // 1. Fechas que están por acercarse o vencidas (Cierre de Proyectos)
  STATE.deals.forEach(d => {
    if (d.stage < 5 && (d.status === 'activo' || d.status === 'active' || !d.status)) {
      if (d.closeDate) {
        const closeDateObj = new Date(d.closeDate + 'T12:00:00');
        const diffDays = Math.ceil((closeDateObj - hoy) / (1000 * 60 * 60 * 24));
        
        if (closeDateObj < hoy) {
          alerts.push({
            id: 'n_venc_' + d.id,
            type: 'urgent',
            icon: 'alert-triangle',
            title: `Cierre Vencido: ${d.title}`,
            text: `El proyecto con ${d.clientName || 'Cliente'} debió cerrar el ${fmtDate(d.closeDate)}. ¡Revisa el estatus!`,
            action: `openDealModal('${d.id}')`,
            actionText: 'Seguimiento'
          });
        } else if (diffDays >= 0 && diffDays <= 5) {
          alerts.push({
            id: 'n_prox_' + d.id,
            type: 'warning',
            icon: 'clock',
            title: `Cierre Próximo: ${d.title}`,
            text: `Cierre programado en ${diffDays} día(s) (${fmtDate(d.closeDate)}). ¡Asegura los detalles!`,
            action: `openDealModal('${d.id}')`,
            actionText: 'Revisar'
          });
        }
      }
    }
  });

  // 2. Proyectos que atender (Estancados o Alta Prioridad/Valor)
  STATE.deals.forEach(d => {
    if (d.stage < 5 && (d.status === 'activo' || d.status === 'active' || !d.status)) {
      const createdDate = new Date(d.createdAt || Date.now());
      const diffDays = Math.floor((hoy - createdDate) / (1000 * 60 * 60 * 24));
      
      const isHighValue = (parseFloat(d.value) || 0) >= 30000;
      const isHighPriority = d.priority === 'high';
      
      if (diffDays >= 15 && (isHighValue || isHighPriority)) {
        alerts.push({
          id: 'n_aten_' + d.id,
          type: 'warning',
          icon: 'trending-up',
          title: `Atender Proyecto: ${d.title}`,
          text: `Proyecto prioritario o de alto valor lleva ${diffDays} días en la etapa actual.`,
          action: `openDealModal('${d.id}')`,
          actionText: 'Atender'
        });
      }
    }
  });

  // 3. Clientes Olvidados (Activos sin movimientos por > 30 días)
  STATE.clients.forEach(c => {
    const mc = mergedClient(c);
    const clientDeals = STATE.deals.filter(d => d.clientId === c.id && d.stage < 5 && (d.status === 'activo' || d.status === 'active' || !d.status));
    if (clientDeals.length > 0) {
      const oldestActive = clientDeals.reduce((oldest, d) => {
        const dt = new Date(d.createdAt || Date.now());
        return dt < oldest ? dt : oldest;
      }, new Date());
      
      const diffDays = Math.floor((hoy - oldestActive) / (1000 * 60 * 60 * 24));
      if (diffDays >= 30) {
        alerts.push({
          id: 'n_olv_' + c.id,
          type: 'info',
          icon: 'user-minus',
          title: `Cliente Olvidado: ${mc.nombre}`,
          text: `El cliente tiene proyectos activos sin movimientos desde hace ${diffDays} días. ¡Contáctalo!`,
          action: `openDealModal('${clientDeals[0].id}')`,
          actionText: 'Seguimiento'
        });
      }
    }
  });

  // 4. Clientes Fríos (Sin proyectos activos pero con ventas históricas)
  // Limitamos a los top 3 para evitar saturación, con un resumen si hay más.
  const coldClients = STATE.clients
    .map(c => {
      const activeCount = STATE.deals.filter(d => d.clientId === c.id && d.stage < 5).length;
      return { client: c, activeCount };
    })
    .filter(item => item.activeCount === 0 && item.client.ventas > 0)
    .sort((a, b) => b.client.ventas - a.client.ventas);

  const topCold = coldClients.slice(0, 3);
  topCold.forEach(item => {
    const c = item.client;
    alerts.push({
      id: 'n_frio_' + c.id,
      type: 'info',
      icon: 'users',
      title: `Cliente Frío: ${c.nombre}`,
      text: `Cliente sin proyectos activos. Ventas históricas: ${fmt(c.ventas)}. ¡Reactívalo!`,
      action: `openDealModal(null, '${c.id}')`,
      actionText: '+ Negocio'
    });
  });

  if (coldClients.length > 3) {
    alerts.push({
      id: 'n_frio_resumen',
      type: 'info',
      icon: 'help-circle',
      title: `Seguimiento de Clientes Fríos`,
      text: `Tienes un total de ${coldClients.length} clientes fríos sin proyectos activos en el sistema.`,
      action: `navigate('directorio')`,
      actionText: 'Ver Directorio'
    });
  }

  // Renderizar recuento de notificaciones
  if (countEl) {
    countEl.textContent = alerts.length;
    countEl.style.display = alerts.length > 0 ? 'flex' : 'none';
  }

  if (alerts.length === 0) {
    listEl.innerHTML = `<div class="empty-state" style="padding: 24px 12px; text-align: center;"><i data-lucide="check-circle" style="color: var(--accent-success); width: 24px; height: 24px; margin-bottom: 8px; display: inline-block;"></i><p style="font-size: 12px; color: var(--text-muted); text-align: center;">¡Excelente! No tienes alertas de seguimiento pendientes hoy.</p></div>`;
    safeIcons();
    return;
  }

  listEl.innerHTML = alerts.map(a => {
    const borderCls = { urgent: 'border-left: 3px solid #ef4444', warning: 'border-left: 3px solid #f59e0b', info: 'border-left: 3px solid #3b82f6', success: 'border-left: 3px solid #10b981' }[a.type] || '';
    const iconCls = { urgent: 'text-danger', warning: 'text-warning', info: 'text-info', success: 'text-success' }[a.type] || '';
    return `
      <div class="notification-item glass" style="padding: 10px 12px; border-radius: var(--radius-xs); border: 1px solid var(--glass-border); ${borderCls}; display: flex; flex-direction: column; gap: 6px; background: rgba(255,255,255,0.02); text-align: left;">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
          <div style="display: flex; gap: 8px; align-items: center;">
            <i data-lucide="${a.icon}" style="width: 14px; height: 14px; flex-shrink: 0;" class="${iconCls}"></i>
            <strong style="font-size: 12px; color: var(--text-primary); text-align: left;">${esc(a.title)}</strong>
          </div>
        </div>
        <p style="font-size: 11px; color: var(--text-muted); margin: 0; line-height: 1.4; text-align: left;">${esc(a.text)}</p>
        <div style="display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px;">
          <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation();${a.action};document.getElementById('notifications-panel').classList.add('hidden');" style="font-size: 10px; padding: 4px 10px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.05); color: var(--text-primary); cursor: pointer; border-radius: 4px;">
            ${a.actionText}
          </button>
        </div>
      </div>
    `;
  }).join('');
  
  safeIcons();
}

// ─────────────────────────────────────────────────────────────────
// BÚSQUEDA RÁPIDA DE CLIENTES & AGREGAR DIRECTO AL PIPELINE
// ─────────────────────────────────────────────────────────────────
window.renderQuickSearchResults = (search = '') => {
  const query = search.toLowerCase().trim();
  const resultsEl = document.getElementById('quick-client-search-results');
  if (!resultsEl) return;

  let filtered = STATE.clients;
  if (query) {
    filtered = STATE.clients.filter(c => {
      const mc = mergedClient(c);
      return mc.nombre.toLowerCase().includes(query)
        || (mc.contacto || '').toLowerCase().includes(query)
        || (mc.zona || '').toLowerCase().includes(query)
        || (mc.telefono1 || '').includes(query)
        || (mc.telefono2 || '').includes(query);
    });
  }

  if (!filtered.length) {
    resultsEl.innerHTML = `<div class="empty-state" style="padding: 24px; text-align: center;"><p style="font-size: 12px; color: var(--text-muted);">No se encontraron clientes para "${esc(search)}"</p></div>`;
    return;
  }

  resultsEl.innerHTML = filtered.map(c => {
    const mc = mergedClient(c);
    const subtitle = [
      mc.contacto ? `Dueño: ${mc.contacto}` : null,
      mc.zona ? `Zona: ${mc.zona}` : null,
      mc.telefono1 ? `Tel: ${mc.telefono1}` : null
    ].filter(Boolean).join(' · ');

    return `
      <div class="quick-search-item animate-slide-up">
        <div class="client-info">
          <span class="client-title">${esc(mc.nombre)}</span>
          <span class="client-sub">${esc(subtitle || 'Sin datos adicionales')}</span>
        </div>
        <button class="btn btn-primary btn-sm btn-quick-pipeline-add" onclick="quickAddClientToPipeline('${c.id}')" style="box-shadow: none; font-size: 11px;">
          <i data-lucide="plus-circle" style="width: 13px; height: 13px;"></i> + Pipeline
        </button>
      </div>
    `;
  }).join('');

  safeIcons();
};

window.quickAddClientToPipeline = (clientId) => {
  const client = STATE.clients.find(c => c.id === clientId);
  if (!client) {
    toast('Cliente no encontrado', 'error');
    return;
  }

  const mc = mergedClient(client);

  // Crear nuevo negocio por defecto en etapa 0 (Prospección)
  const deal = {
    id: generateUUID(),
    title: 'Negocio - ' + mc.nombre,
    value: 5000, // valor inicial por defecto
    clientId: mc.id,
    clientName: mc.nombre,
    stage: 0, // Prospección
    priority: 'medium',
    closeDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0], // 30 días a futuro
    notes: 'Agregado rápidamente al pipeline desde el buscador.',
    status: 'active',
    createdAt: new Date().toISOString(),
    closedAt: null
  };

  STATE.deals.push(deal);
  saveLocal();
  closeModal('modal-quick-client-search');
  renderAll();
  toast(`¡Negocio creado para ${mc.nombre} en el pipeline! ✓`, 'success');
};


window.applyTeamModeFilter = function() {
  if (!STATE.auth.user) return;
  const currentUserId = STATE.auth.user.id;
  if (STATE.ui.teamMode) {
    STATE.deals = [...STATE.allDeals];
  } else {
    STATE.deals = STATE.allDeals.filter(d => !d.user_id || d.user_id === currentUserId);
  }
};



/* ==========================================================================
   RUTAS Y MAPAS (LEAFLET INTEGRATION)
   ========================================================================== */
let rutasMap = null;
let rutasMarkers = [];
let isGeocoding = false;
let geocodeQueue = [];
let _geocodeTotal = 0;

// Coordenadas centro (Chihuahua)
const CHIH_CENTER = { lat: 28.6330, lng: -106.0691 };

window.initRutasMap = function() {
    if (!rutasMap) {
        rutasMap = L.map('rutas-map-container', {
            zoomControl: false // Lo agregaremos custom
        }).setView([CHIH_CENTER.lat, CHIH_CENTER.lng], 12);
        
        // Agregar capa oscura tipo CartoDB Dark Matter o similar
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
            subdomains: 'abcd',
            maxZoom: 20
        }).addTo(rutasMap);

        L.control.zoom({
            position: 'bottomleft'
        }).addTo(rutasMap);
    } else {
        rutasMap.invalidateSize();
    }
    
    renderRutas();
};

function renderRutas() {
    if (!rutasMap) return;
    
    const filterZona = document.getElementById('rutas-filter-zona').value;
    const filterInd = document.getElementById('rutas-filter-industria').value;
    
    // Poblar filtro industrias si esta vacio
    const selectInd = document.getElementById('rutas-filter-industria');
    if (selectInd.options.length <= 1) {
        const indus = [...new Set(STATE.clients.map(c => c.sector).filter(Boolean))].sort();
        indus.forEach(i => {
            let opt = document.createElement('option');
            opt.value = i;
            opt.textContent = i;
            selectInd.appendChild(opt);
        });
    }

    // Limpiar marcadores
    rutasMarkers.forEach(m => rutasMap.removeLayer(m));
    rutasMarkers = [];
    
    const listContainer = document.getElementById('rutas-client-list');
    listContainer.innerHTML = '';
    
    // Clasificar y filtrar clientes
    let toShow = [];
    let toGeocode = [];
    
    STATE.clients.forEach(c => {
        let extras = STATE.clientExtras[c.id] || {};
        let direccion = extras.zona || c.zona || '';
        
        // Filtro Industria
        if (filterInd !== 'all' && c.sector !== filterInd) return;
        
        if (extras.lat && extras.lng) {
            // Clasificar Zona
            let zonaGeo = '';
            if (extras.lat > CHIH_CENTER.lat) zonaGeo = 'Norte';
            else zonaGeo = 'Sur';
            // Para simplificar, priorizamos Norte/Sur, pero si esta muy al este/oeste lo cambiamos
            if (Math.abs(extras.lng - CHIH_CENTER.lng) > Math.abs(extras.lat - CHIH_CENTER.lat)) {
                if (extras.lng > CHIH_CENTER.lng) zonaGeo = 'Este';
                else zonaGeo = 'Oeste';
            }
            c._zonaGeo = zonaGeo;
            
            if (filterZona === 'all' || filterZona === zonaGeo) {
                toShow.push(c);
            }
        } else {
            // No tiene coordenadas — todos los clientes van a geocodificarse
            // Usamos direccion si existe, si no usamos el nombre como query
            c._geoQuery = direccion.trim() || c.nombre;
            toGeocode.push(c);
        }
    });
    
    document.getElementById('rutas-list-count').textContent = toShow.length;
    
    // Render Lista
    toShow.forEach(c => {
        let extras = STATE.clientExtras[c.id] || {};
        
        // Marker Map
        let iconHtml = `<div style="background:var(--accent-primary); width:14px; height:14px; border-radius:50%; border:2px solid white; box-shadow:0 0 10px rgba(99,102,241,0.8);"></div>`;
        let divIcon = L.divIcon({ html: iconHtml, className: '', iconSize: [14, 14], iconAnchor: [7, 7] });
        let marker = L.marker([extras.lat, extras.lng], { icon: divIcon }).addTo(rutasMap);
        
        let popupStr = `
            <h4>${c.nombre}</h4>
            <p><strong>Industria:</strong> ${c.sector || 'N/A'}</p>
            <p><strong>Dirección:</strong> ${c.zona || 'N/A'}</p>
            <p><strong>Zona Asignada:</strong> ${c._zonaGeo}</p>
            <a href="#" onclick="navigate('clientes'); document.getElementById('client-search').value='${c.nombre.substring(0, 10)}'; document.getElementById('client-search').dispatchEvent(new Event('input')); return false;" style="color:var(--accent-primary); display:inline-block; margin-top:8px;">Ver en Directorio</a>
        `;
        marker.bindPopup(popupStr);
        rutasMarkers.push(marker);
        
        // Elemento lista
        let el = document.createElement('div');
        el.className = 'ruta-client-card';
        el.innerHTML = `
            <div class="ruta-client-name">${c.nombre}</div>
            <div class="ruta-client-zone">
                <i data-lucide="map-pin" style="width:12px; height:12px;"></i> ${c._zonaGeo} • ${c.sector || 'Sin sector'}
            </div>
        `;
        el.addEventListener('click', () => {
            rutasMap.flyTo([extras.lat, extras.lng], 16, { animate: true, duration: 1 });
            marker.openPopup();
        });
        listContainer.appendChild(el);
    });
    
    if (window.lucide) window.lucide.createIcons();
    
    // Auto-geocodificar si hay pendientes y usuario lo solicita
    document.getElementById('btn-rutas-refresh').onclick = () => {
        if (!isGeocoding && toGeocode.length > 0) {
            geocodeQueue = [...toGeocode];
            _geocodeTotal = geocodeQueue.length;
            toast(`Iniciando geolocalización de ${_geocodeTotal} clientes...`, 'info');
            startGeocoding();
        } else if (toGeocode.length === 0 && toShow.length > 0) {
            toast('Todos los clientes ya están geolocalizados ✓', 'success');
        } else if (toGeocode.length === 0 && toShow.length === 0) {
            toast('No se encontraron clientes para geolocalizar', 'warning');
        } else if (isGeocoding) {
            toast('Ya se está geolocalizando, espera a que termine...', 'warning');
        }
    };
}

async function startGeocoding() {
    if (geocodeQueue.length === 0) {
        isGeocoding = false;
        document.getElementById('rutas-geo-progress').classList.add('hidden');
        renderRutas();
        toast('Geolocalización completada. ' + Object.keys(STATE.clientExtras).filter(k => STATE.clientExtras[k].lat).length + ' clientes ubicados.', 'success');
        return;
    }
    
    isGeocoding = true;
    document.getElementById('rutas-geo-progress').classList.remove('hidden');
    
    let c = geocodeQueue.shift();
    
    const processed = _geocodeTotal - geocodeQueue.length;
    const pct = Math.round((processed / _geocodeTotal) * 100);
    document.getElementById('rutas-geo-bar').style.width = pct + '%';
    document.getElementById('rutas-geo-text').textContent = `Procesando: ${processed}/${_geocodeTotal} — ${c.nombre.substring(0, 25)}`;
    
    // Generate fallback queries
    const queries = [];
    const raw = (c._geoQuery || c.nombre || '').trim();
    if (raw) {
        // Clean address
        let clean = raw
            .replace(/INT\.?\s*[0-9a-zA-Z-]*\b/gi, '')
            .replace(/C\.?P\.?\s*\d+\b/gi, '')
            .replace(/COL\.?\b/gi, '')
            .replace(/\s+/g, ' ')
            .trim();
        
        queries.push(`${clean}, Chihuahua, Chihuahua, Mexico`);
        
        let parts = raw.split(',').map(p => p.trim());
        if (parts.length > 0) {
            let street = parts[0]
                .replace(/INT\.?\s*[0-9a-zA-Z-]*\b/gi, '')
                .replace(/C\.?P\.?\s*\d+\b/gi, '')
                .replace(/COL\.?\b/gi, '')
                .replace(/\s+/g, ' ')
                .trim();
            queries.push(`${street}, Chihuahua, Chihuahua, Mexico`);
            
            // Street only (no number)
            let streetOnly = street.replace(/\d+/g, '').trim();
            if (streetOnly && streetOnly !== street) {
                queries.push(`${streetOnly}, Chihuahua, Chihuahua, Mexico`);
                
                // Clean prefix like Avenida, Calle, Av, C
                let cleanStreetOnly = streetOnly.replace(/^(av\.|avenida|calle|c\.)\s+/gi, '').trim();
                if (cleanStreetOnly && cleanStreetOnly !== streetOnly) {
                    queries.push(`${cleanStreetOnly}, Chihuahua, Chihuahua, Mexico`);
                }
            }
        }
        
        if (parts.length > 1) {
            let neighborhood = parts[1].replace(/COL\.?\b/gi, '').trim();
            if (neighborhood) {
                queries.push(`${neighborhood}, Chihuahua, Chihuahua, Mexico`);
            }
        }
    }
    
    // Remove duplicates
    const uniqueQueries = [...new Set(queries)];
    
    // Try each query sequentially
    let coords = null;
    for (let q of uniqueQueries) {
        try {
            let res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1`);
            let data = await res.json();
            if (data && data.length > 0) {
                coords = {
                    lat: parseFloat(data[0].lat),
                    lng: parseFloat(data[0].lon)
                };
                console.log(`Geocoded '${c.nombre}' using query: '${q}' ->`, coords);
                break;
            }
        } catch (e) {
            console.warn('Query failed:', q, e);
        }
        // Small delay between fallback attempts to avoid rate limiting
        await new Promise(r => setTimeout(r, 600));
    }
    
    if (coords) {
        if (!STATE.clientExtras[c.id]) STATE.clientExtras[c.id] = {};
        STATE.clientExtras[c.id].lat = coords.lat;
        STATE.clientExtras[c.id].lng = coords.lng;
        saveLocal();
    } else {
        console.warn(`Could not geocode client: ${c.nombre}`);
    }
    
    // Delay 1.5 seconds before next client
    setTimeout(startGeocoding, 1500);
}

// Bind filters
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('rutas-filter-zona')?.addEventListener('change', renderRutas);
    document.getElementById('rutas-filter-industria')?.addEventListener('change', renderRutas);
});

