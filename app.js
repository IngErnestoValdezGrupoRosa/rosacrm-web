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
  deals:        [],   // filtrados (Mis Negocios o Equipo)
  allDeals:     [],   // todos los negocios cargados desde Supabase
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
    teamMode:      false,
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
      if (!isUUID(d.id)) {
        d.id = generateUUID();
      }
      
      // Si el deal no tiene dueño (migrado), asignarle el actual
      if (!d.user_id) {
        d.user_id = currentUserId;
        d.user_name = currentUserName;
      }
      
      // No permitimos editar deals que no son nuestros a menos que se requiera, 
      // pero por ahora el upsert los actualizará si RLS lo permite.
      
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
      
      if (isUUID(d.clientId)) {
        row.cliente_id = d.clientId;
      }
      const { error } = await _supabase.from('deals').upsert(row, { onConflict: 'id' });
      if (error && error.message && error.message.includes('archived')) {
        const { archived: _, ...rowWithoutArchived } = row;
        await _supabase.from('deals').upsert(rowWithoutArchived, { onConflict: 'id' });
      }
    }
    
    // Actualizar allDeals localmente
    STATE.deals.forEach(d => {
      const idx = STATE.allDeals.findIndex(x => x.id === d.id);
      if (idx >= 0) STATE.allDeals[idx] = { ...d };
      else STATE.allDeals.push({ ...d });
    });
    
    saveLocal(); // Guardar IDs actualizados
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
    nombre:    ex.nombre    || c.nombre,
    contacto:  ex.contacto  || c.contacto,
    telefono1: ex.tel1      || c.telefono1,
    telefono2: ex.tel2      || c.telefono2,
    email:     ex.email     || '',
    industria: ex.industria || '',
    zona:      ex.zona      || c.zona,
    notas:     ex.notas     || '',
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
    
    // Evitar parpadeos o doble ejecución en eventos secundarios
    if (STATE.auth.session?.access_token === session?.access_token && event !== 'SIGNED_IN') return;

    STATE.auth.session = session;
    STATE.auth.user = session?.user;

    if (session && session.user) {
      // Ocultar login
      authContainer.classList.add('hidden');
      
      const userName = session.user.user_metadata?.full_name || session.user.email.split('@')[0];
      
      // Actualizar perfil en sidebar
      document.getElementById('sidebar-user-name').textContent = userName;
      document.getElementById('sidebar-user-avatar').textContent = userName.substring(0, 2).toUpperCase();

      // Flujo de Splash Screen solo al iniciar sesión
      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
        splashScreen.classList.remove('hidden');
        splashScreen.style.display = 'flex';
        
        // Reproducir video desde el inicio
        const video = document.getElementById('splash-video');
        if(video) {
          video.currentTime = 0;
          video.play().catch(e => console.warn(e));
        }
        
        // Ocultar splash y mostrar CRM después de 4.5s
        setTimeout(() => {
          splashScreen.classList.add('hidden');
          splashScreen.style.display = 'none';
          mainAppContainer.classList.remove('hidden');
          
          // Iniciar app
          syncDirectorio();
          renderAll();
          
          if (!STATE.config.onboardingDone) {
            setTimeout(() => openModal('modal-onboarding'), 800);
          }
        }, 4500);
      } else {
        // Si ya pasó el splash, mostrar CRM directo
        splashScreen.classList.add('hidden');
        splashScreen.style.display = 'none';
        mainAppContainer.classList.remove('hidden');
        syncDirectorio();
        renderAll();
      }
    } else {
      // Mostrar login, ocultar app y splash
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
    
    // Mostrar campo de nombre solo si se va a registrar
    const nameGroup = document.getElementById('auth-name-group');
    if (isLogin) {
      nameGroup.classList.add('hidden');
      document.getElementById('auth-name').removeAttribute('required');
    } else {
      nameGroup.classList.remove('hidden');
      document.getElementById('auth-name').setAttribute('required', 'true');
    }
    
    document.getElementById('auth-error').classList.add('hidden');
    document.getElementById('auth-success').classList.add('hidden');
  });

  // Formulario de Email/Password
  document.getElementById('auth-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('auth-email').value;
    const password = document.getElementById('auth-password').value;
    const name = document.getElementById('auth-name').value;
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
        sucDiv.textContent = "Registro exitoso. Serás redirigido.";
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
        STATE.allDeals = dealRows.map(d => ({
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
          closedAt:   null,
          archived:   d.archived || false,
          user_id:    d.user_id || '',
          user_name:  d.user_name || ''
        }));
        
        applyTeamModeFilter();
        console.log('[RosaCRM] 📦 Deals cargados desde Supabase:', dealRows.length);
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
    };
    const [t, s] = titles[section] || ['RosaCRM', ''];
    setText('page-title', t);
    setText('page-subtitle', s);

    if (section === 'dashboard') {
      renderDashboard();
    } else if (section === 'pipeline') {
      renderPipeline();
    } else if (section === 'clientes') {
      renderClients();
    } else if (section === 'configuracion') {
      syncConfigUI();
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
        const contacto   = mc?.contacto || '';

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
    if (newStage === 5 && deal.status === 'active') {
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
    renderAll();

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
      const mz = zone === 'all' || c.zona === zone;
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
    const selZone = document.getElementById('client-filter-zone');
    if (selZone) {
      const zones   = [...new Set(STATE.clients.map(c => c.zona).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
      const current = selZone.value;
      selZone.innerHTML = `<option value="all">Todas las Zonas</option>` + zones.map(z => `<option value="${esc(z)}">${esc(z)}</option>`).join('');
      if (zones.includes(current)) selZone.value = current;
    }

    const selInd = document.getElementById('client-filter-industry');
    if (selInd) {
      const industries = [...new Set(STATE.clients.map(c => c.sector).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
      const current = selInd.value;
      selInd.innerHTML = `<option value="all">Todas las Industrias</option>` + industries.map(i => `<option value="${esc(i.toUpperCase())}">${esc(i.toUpperCase())}</option>`).join('');
      if (industries.includes(current)) selInd.value = current;
    }
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

    setText('det-desc',         c.notas || 'Sin notas registradas');
    setText('det-customers',    '—');
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
      openClientEditModal(id);   // ← función correcta (antes llamaba openDealModal por error)
    }, { once: true });

    openModal('modal-client-detail');
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
      nombre:    $v('edit-client-nombre').trim()    || undefined,
      contacto:  $v('edit-client-contacto').trim()  || undefined,
      tel1:      $v('edit-client-tel1').trim()       || undefined,
      tel2:      $v('edit-client-tel2').trim()       || undefined,
      email:     $v('edit-client-email').trim()      || undefined,
      industria: $v('edit-client-industria').trim()  || undefined,
      zona:      $v('edit-client-zona').trim()       || undefined,
      notas:     $v('edit-client-notas').trim()      || undefined,
    };
    // Limpiar undefined para no guardar basura
    Object.keys(STATE.clientExtras[id]).forEach(k => {
      if (STATE.clientExtras[id][k] === undefined) delete STATE.clientExtras[id][k];
    });

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

  // Click fuera del modal
  document.querySelectorAll('.modal').forEach(m =>
    m.addEventListener('click', e => { if (e.target === m) closeModal(m.id); })
  );
}

// ─────────────────────────────────────────────────────────────────
// FILTERS
// ─────────────────────────────────────────────────────────────────
function bindFilters() {
  // Cartera
  document.getElementById('client-search')?.addEventListener('input', e => {
    STATE.ui.clientSearch = e.target.value;
    STATE.ui.clientPage   = 1;
    renderClients();
  });
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
  document.getElementById('pipeline-filter-search')?.addEventListener('input', e => {
    STATE.ui.pipeSearch = e.target.value;
    renderPipeline();
  });
  document.getElementById('pipeline-filter-priority')?.addEventListener('change', e => {
    STATE.ui.pipePriority = e.target.value;
    renderPipeline();
  });

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
    if (d.stage < 5 && d.status === 'activo') {
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
    if (d.stage < 5 && d.status === 'activo') {
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
    const clientDeals = STATE.deals.filter(d => d.clientId === c.id && d.stage < 5 && d.status === 'activo');
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
