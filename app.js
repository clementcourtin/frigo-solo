import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const supabase = createClient('https://xxvxmefrrkuurlnxyxsn.supabase.co', 'sb_publishable_sb_FFicGYl7AZS8wxL8GvA_ev8j0Btp');
const appUrl = `${window.location.origin}${window.location.pathname}`;
// Un vrai chemin .ics (sans paramètre dans l’URL) est mieux accepté par Calendrier sur iPhone.
const calendarEndpoint = 'https://frigo-solo-calendar.clementhealeaucrt.workers.dev';
const $ = (s) => document.querySelector(s);
const form = $('#food-form'), authForm = $('#auth-form'), email = $('#email'), authCodeRow = $('#auth-code-row'), authCode = $('#auth-code'), verifyAuthCode = $('#verify-auth-code');
const foodDialog = $('#food-dialog'), addTrigger = $('#open-add'), closeAdd = $('#close-add'), signedInEmail = $('#signed-in-email');
const authMessage = $('#auth-message'), foodMessage = $('#food-message'), nameInput = $('#food-name'), dateInput = $('#food-date');
const calendarSetup = $('#calendar-setup'), calendarLink = $('#calendar-link'), copyCalendarLink = $('#copy-calendar-link');
const authCard = $('#auth-card'), accountBar = $('#account-bar'), adminLink = $('#admin-link'), showCalendar = $('#show-calendar'), hideCalendar = $('#hide-calendar');
const deleteAccountButton = $('#delete-account'), privacyDialog = $('#privacy-dialog'), showPrivacy = $('#show-privacy'), closePrivacy = $('#close-privacy');
const barcodeInput = $('#barcode'), locationInput = $('#food-location'), quantityInput = $('#food-quantity'), unitInput = $('#food-unit');
const lookupButton = $('#lookup-barcode'), scanButton = $('#start-scan'), scannerElement = $('#scanner'), scanMessage = $('#scan-message');
const scanControls = $('#scan-controls'), torchButton = $('#toggle-torch');
const foods = $('#foods'), empty = $('#empty-state'), clearAll = $('#clear-all'), template = $('#food-template'), foodCount = $('#food-count');
const prioritySection = $('#priority-section'), prioritySummary = $('#priority-summary');
const shoppingCard = $('#shopping-card'), shoppingForm = $('#shopping-form'), shoppingName = $('#shopping-name');
const shoppingItems = $('#shopping-items'), shoppingEmpty = $('#shopping-empty'), clearBought = $('#clear-bought'), shoppingTemplate = $('#shopping-template');
const filterButtons = [...document.querySelectorAll('.filter-button')];
const addFoodButton = form.querySelector('button[type="submit"]');
let entries = [], shoppingEntries = [], activeLocation = 'all', scanner, isScanning = false, torchOn = false, lastScannedCode = '', activeUserId = '';
let publicSettings = { maintenance: { enabled: false, message: '' }, banner: { enabled: false, message: '' } };
function isMaintenance() { return Boolean(publicSettings.maintenance?.enabled); }
function showServiceNotice() {
  const maintenance = publicSettings.maintenance || {}, banner = publicSettings.banner || {};
  const visible = maintenance.enabled || banner.enabled;
  let notice = document.querySelector('#service-notice');
  if (!visible) { notice?.remove(); return; }
  if (!notice) {
    notice = document.createElement('p');
    notice.id = 'service-notice';
    notice.setAttribute('role', 'status');
    notice.style.cssText = 'margin:0 0 16px;padding:12px 14px;border:1px solid #e6c991;border-radius:14px;background:#fff4df;color:#74531b;font-size:.86rem;font-weight:700;line-height:1.4';
    const shell = document.querySelector('main.shell');
    shell?.insertBefore(notice, shell.firstChild);
  }
  notice.textContent = maintenance.enabled
    ? (maintenance.message || 'Frigo Solo fait une petite pause technique. Les modifications seront bientôt de retour.')
    : banner.message;
}
async function loadPublicSettings() {
  const { data } = await supabase.rpc('app_public_settings');
  if (data) publicSettings = data;
  showServiceNotice();
}
function maintenanceBlocked(target = authMessage) {
  if (!isMaintenance()) return false;
  message(target, publicSettings.maintenance?.message || 'Frigo Solo est temporairement en maintenance. Réessaie dans quelques instants.', true);
  return true;
}

function barcodeFormats() {
  const formats = window.Html5QrcodeSupportedFormats;
  return [formats.EAN_13, formats.EAN_8, formats.UPC_A, formats.UPC_E];
}

function message(target, text, error = false) { target.textContent = text; target.style.color = error ? '#9a3d31' : ''; }
function daysUntil(date) { const t = new Date(`${date}T12:00:00`), n = new Date(); n.setHours(12, 0, 0, 0); return Math.round((t - n) / 86400000); }
function status(days) {
  if (days < 0) return ['expired', `Périmé depuis ${Math.abs(days)} jour${days === -1 ? '' : 's'}`];
  if (days === 0) return ['today', 'À consommer d’ici ce soir'];
  if (days === 1) return ['soon', 'À consommer d’ici demain'];
  return days <= 3 ? ['soon', `À consommer d’ici ${days} jours`] : ['later', `À consommer d’ici ${days} jours`];
}
function quantityLabel(item) { const q = Number(item.quantity || 1), u = item.unit === 'unité' ? 'paquet' : (item.unit || 'paquet'); return `${q} ${u}${u === 'paquet' && q > 1 ? 's' : ''} · ${item.location || 'Frigo'}`; }
function quantityStep(item) { return ['g', 'ml'].includes(item.unit) ? 100 : ['kg', 'L'].includes(item.unit) ? 0.1 : 1; }
function quantityText(item) { const quantity = Number(item.quantity || 1), unit = item.unit === 'unité' ? 'paquet' : (item.unit || 'paquet'); return `${Number.isInteger(quantity) ? quantity : quantity.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')} ${unit}`; }
function updateAddButton() { addFoodButton.textContent = `Ajouter au ${locationInput.value.toLowerCase()}`; }

function render() {
  const ordered = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  const priority = ordered.filter((item) => daysUntil(item.date) <= 3).slice(0, 3);
  prioritySection.hidden = !priority.length;
  if (priority.length) prioritySummary.textContent = priority.map((item) => `${item.name} (${status(daysUntil(item.date))[1].toLowerCase()})`).join(' · ');
  const visible = activeLocation === 'all' ? ordered : ordered.filter((item) => (item.location || 'Frigo') === activeLocation);
  foods.innerHTML = '';
  foodCount.textContent = entries.length ? `${entries.length} article${entries.length > 1 ? 's' : ''}` : '';
  empty.hidden = Boolean(visible.length);
  const emptyMessages = {
    all: 'Ton stock est vide par ici. Ajoute ton premier aliment.',
    Frigo: 'Pas de bouffe dans le frigo. Une petite course ?',
    Congélateur: 'Rien de nouveau au congélo. Il garde son calme.',
    Placard: "Y'a rien. Même pas de monstre dans le placard."
  };
  empty.textContent = visible.length ? '' : emptyMessages[activeLocation];
  clearAll.hidden = !entries.length;
  for (const item of visible) {
    const node = template.content.cloneNode(true), row = node.querySelector('li'), [kind, label] = status(daysUntil(item.date));
    row.classList.add(kind); node.querySelector('strong').textContent = item.name;
    node.querySelector('.food-meta').textContent = quantityLabel(item); node.querySelector('.food-date').textContent = label;
    node.querySelector('.item-quantity').textContent = quantityText(item);
    node.querySelector('.quantity-minus').addEventListener('click', () => changeQuantity(item, -1));
    node.querySelector('.quantity-plus').addEventListener('click', () => changeQuantity(item, 1));
    node.querySelector('.shop-button').addEventListener('click', () => addToShopping(item.name));
    node.querySelector('.consume-button').addEventListener('click', () => consumeFood(item.id));
    row.style.touchAction = 'pan-y';
    let swipeStartX = 0, swipeStartY = 0, isHorizontalSwipe = false;
    const resetSwipe = () => { row.style.transform = ''; row.style.opacity = ''; row.style.background = ''; row.style.boxShadow = ''; };
    row.addEventListener('touchstart', (event) => { const t = event.changedTouches[0]; swipeStartX = t.clientX; swipeStartY = t.clientY; isHorizontalSwipe = false; row.style.transition = 'none'; }, { passive: true });
    row.addEventListener('touchmove', (event) => { const t = event.changedTouches[0], x = t.clientX - swipeStartX, y = t.clientY - swipeStartY; if (Math.abs(x) <= Math.abs(y)) return; isHorizontalSwipe = true; event.preventDefault(); const strength = Math.min(Math.abs(x) / 150, 1); row.style.transform = 'translate3d(' + x + 'px, 0, 0)'; row.style.opacity = String(1 - Math.min(Math.abs(x) / 900, .28)); row.style.background = x < 0 ? 'rgba(211, 87, 76, ' + (strength * .28) + ')' : 'rgba(76, 151, 97, ' + (strength * .28) + ')'; row.style.boxShadow = x < 0 ? '-8px 4px 20px rgba(211, 87, 76, ' + (strength * .28) + ')' : '8px 4px 20px rgba(76, 151, 97, ' + (strength * .28) + ')'; }, { passive: false });
    row.addEventListener('touchend', (event) => { const t = event.changedTouches[0], x = t.clientX - swipeStartX; row.style.transition = 'transform 260ms cubic-bezier(.22,.8,.25,1), opacity 220ms ease, background 220ms ease, box-shadow 220ms ease'; if (!isHorizontalSwipe || Math.abs(x) < 92) { resetSwipe(); return; } row.style.transform = 'translate3d(' + (x < 0 ? '-112%' : '112%') + ', 0, 0)'; setTimeout(() => { if (x < 0) consumeFood(item.id); else { addToShopping(item.name); resetSwipe(); } }, 260); }, { passive: true });
    row.addEventListener('touchcancel', () => { row.style.transition = 'transform 180ms ease, opacity 180ms ease, background 180ms ease, box-shadow 180ms ease'; resetSwipe(); }, { passive: true });
    foods.append(node);
  }
}
async function loadFoods() {
  const { data, error } = await supabase.from('food_items').select('*').order('expires_on');
  if (error) return message(authMessage, 'Impossible de charger ton frigo. Réessaie dans un instant.', true);
  entries = data.map((item) => ({ ...item, date: item.expires_on })); render();
}
function renderShopping() {
  shoppingItems.innerHTML = '';
  shoppingEmpty.hidden = Boolean(shoppingEntries.length);
  clearBought.hidden = !shoppingEntries.some((item) => item.checked);
  for (const item of shoppingEntries) {
    const node = shoppingTemplate.content.cloneNode(true), row = node.querySelector('li'), checkbox = node.querySelector('.shopping-check');
    row.classList.toggle('done', item.checked); checkbox.checked = item.checked;
    node.querySelector('.shopping-label').textContent = item.name;
    checkbox.addEventListener('change', () => toggleShopping(item.id, checkbox.checked));
    node.querySelector('.shopping-delete').addEventListener('click', () => deleteShopping(item.id));
    shoppingItems.append(node);
  }
}
async function loadShopping() {
  const { data, error } = await supabase.from('shopping_items').select('*').order('created_at');
  if (error) return message(authMessage, 'Impossible de charger la liste de courses.', true);
  shoppingEntries = data; renderShopping();
}
async function setCalendarLink() {
  const { data: existing, error: readError } = await supabase.from('calendar_feeds').select('token').maybeSingle();
  if (readError) return message(authMessage, 'Impossible de préparer ton calendrier.', true);
  const { data: feed, error: createError } = existing ? { data: existing, error: null } : await supabase.from('calendar_feeds').insert({}).select('token').single();
  if (createError || !feed) return message(authMessage, 'Impossible de préparer ton calendrier.', true);
  calendarLink.value = `${calendarEndpoint}/${feed.token}.ics`;
}
async function updateAdminLink(connected) {
  if (!adminLink) return;
  adminLink.hidden = true;
  if (!connected) return;
  const { data } = await supabase.rpc('app_is_admin');
  adminLink.hidden = !data;
}

async function setSession(session) {
  const user = session?.user, connected = Boolean(user); activeUserId = user?.id || ''; addTrigger.hidden = !connected || isMaintenance(); authCard.hidden = connected; if (connected) authCodeRow.hidden = true; accountBar.hidden = !connected; $('#food-list').hidden = !connected;
  shoppingCard.hidden = !connected;
  await updateAdminLink(connected);
  if (connected) { signedInEmail.textContent = `● Synchronisé · ${user.email}`; await Promise.all([loadFoods(), loadShopping(), isMaintenance() ? Promise.resolve() : setCalendarLink()]); }
  else { entries = []; shoppingEntries = []; signedInEmail.textContent = ''; if (foodDialog.open) foodDialog.close(); render(); renderShopping(); calendarSetup.hidden = true; message(authMessage, ''); }
}

function openDateChoice() {
  dateInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
  dateInput.focus({ preventScroll: true });
  try { dateInput.showPicker?.(); } catch {}
}
function preferenceStore() {
  try { return JSON.parse(localStorage.getItem('frigo-solo-preferences-' + activeUserId) || '{}'); } catch { return {}; }
}
function applyPreference(barcode) {
  if (!activeUserId || !barcode) return false;
  const preference = preferenceStore()[barcode];
  if (!preference) return false;
  locationInput.value = preference.location || locationInput.value;
  quantityInput.value = preference.quantity || quantityInput.value;
  unitInput.value = preference.unit || unitInput.value;
  updateAddButton();
  return true;
}
function rememberPreference(barcode) {
  if (!activeUserId || !barcode) return;
  const preferences = preferenceStore();
  preferences[barcode] = { location: locationInput.value, quantity: quantityInput.value, unit: unitInput.value };
  try { localStorage.setItem('frigo-solo-preferences-' + activeUserId, JSON.stringify(preferences)); } catch {}
}
function conciseProductName(name) { return name.length > 72 ? name.slice(0, 72).replace(/[,;:-][^,;:-]*$/, '').trim() : name.trim(); }
async function lookupProduct(code) {
  const clean = code.replace(/\D/g, '');
  if (clean.length < 8) return message(scanMessage, 'Entre un code-barres valide, ou utilise le scan.', true);
  barcodeInput.value = clean; lookupButton.disabled = true; lookupButton.textContent = '…'; message(scanMessage, 'Recherche du produit…');
  try {
    const response = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(clean)}.json?fields=product_name,product_name_fr,brands`);
    const data = await response.json(), product = data.product, productName = product?.product_name_fr || product?.product_name;
    if (!response.ok || !productName) { message(scanMessage, 'Produit introuvable : tu peux saisir son nom à la main.', true); return nameInput.focus(); }
    const brand = product.brands?.split(',')[0].trim();
    const conciseName = conciseProductName(productName);
    nameInput.value = brand ? brand + ' — ' + conciseName : conciseName;
    const restored = applyPreference(clean);
    message(scanMessage, restored ? 'Produit trouvé : tes habitudes sont déjà remplies. Choisis la date.' : 'Produit trouvé. Choisis la date.');
    openDateChoice();
  } catch { message(scanMessage, 'Impossible de contacter la base produits. Tu peux ajouter le nom à la main.', true); }
  finally { lookupButton.disabled = false; lookupButton.textContent = 'Chercher'; }
}
function resetScanControls() { torchOn = false; scanControls.hidden = true; torchButton.hidden = true; torchButton.classList.remove('active'); torchButton.textContent = '🔦 Lampe'; }
async function setupCameraControls() {
  resetScanControls();
  if (!scanner) return;
  const capabilities = scanner.getRunningTrackCameraCapabilities?.() || scanner.getRunningTrackCapabilities?.() || {};
  const zoom = capabilities.zoom;
  if (zoom) {
    const min = Number(zoom.min ?? 1), max = Number(zoom.max ?? 1);
    const target = Math.min(2, max);
    if (target >= min) {
      try { await scanner.applyVideoConstraints({ advanced: [{ zoom: target }] }); } catch {}
    }
  }
  if (capabilities.torch) { scanControls.hidden = false; torchButton.hidden = false; }
}
async function disposeScanner() {
  const currentScanner = scanner;
  scanner = undefined;
  isScanning = false;
  if (!currentScanner) return;
  try { await currentScanner.stop(); } catch {}
  try { await currentScanner.clear(); } catch {}
}
async function stopScanner() {
  resetScanControls();
  await disposeScanner();
  scannerElement.hidden = true; scanButton.textContent = 'Scanner un code-barre';
}
function scannerFailureMessage(error) {
  const name = String(error?.name || error || '');
  if (/NotAllowed|Permission|denied/i.test(name)) return 'Le navigateur bloque la caméra. Vérifie que « Appareil photo » est autorisé pour Frigo Solo, puis réessaie.';
  if (/NotReadable|TrackStart|in use/i.test(name)) return 'La caméra est déjà utilisée par une autre app. Ferme-la, puis réessaie.';
  if (/NotFound|Overconstrained/i.test(name)) return 'Aucune caméra compatible n’a été trouvée. Essaie avec une autre caméra.';
  return 'Le lecteur n’a pas réussi à démarrer. Réessaie : il basculera automatiquement sur une autre caméra.';
}
function createScanner() {
  return new Html5Qrcode('scanner', { formatsToSupport: barcodeFormats(), useBarCodeDetectorIfSupported: true });
}
async function startScanner() {
  if (isScanning) return stopScanner();
  if (!window.Html5Qrcode) return message(scanMessage, 'Le lecteur de code-barre n’a pas pu se charger. Utilise le champ ci-dessous.', true);
  if (!navigator.mediaDevices?.getUserMedia) return message(scanMessage, 'Ton navigateur ne permet pas d’ouvrir la caméra. Utilise le champ ci-dessous.', true);
  scannerElement.hidden = false; scanButton.textContent = 'Arrêter le scan'; message(scanMessage, 'Ouverture de la caméra…'); lastScannedCode = '';
  await disposeScanner();
  const scanConfig = {
    fps: 10,
    qrbox: { width: 280, height: 150 },
    aspectRatio: 1.777,
    disableFlip: true,
    videoConstraints: {
      facingMode: { ideal: 'environment' },
      zoom: { ideal: 2 },
    },
  };
  const onCodeRead = async (code) => {
    if (code === lastScannedCode) return;
    lastScannedCode = code;
    await stopScanner();
    barcodeInput.value = code;
    await lookupProduct(code);
  };
  let lastError;
  try {
    const cameras = await Html5Qrcode.getCameras();
    const rearCamera = cameras.find((camera) => /back|rear|environment|arrière/i.test(camera.label));
    const attempts = [{ facingMode: { ideal: 'environment' }, zoom: { ideal: 2 } }, rearCamera?.id, cameras[0]?.id, { facingMode: 'environment' }, { facingMode: 'user' }].filter((camera, index, all) => camera && all.indexOf(camera) === index);
    for (const camera of attempts) {
      try {
        scanner = createScanner();
        await scanner.start(camera, scanConfig, onCodeRead, () => {});
        isScanning = true;
        message(scanMessage, 'Cadre le code à plat et attends une seconde.');
        await setupCameraControls();
        return;
      } catch (error) {
        lastError = error;
        await disposeScanner();
      }
    }
  } catch (error) { lastError = error; }
  await stopScanner();
  message(scanMessage, scannerFailureMessage(lastError), true);
}
async function toggleTorch() {
  if (!scanner || !isScanning) return;
  try { torchOn = !torchOn; await scanner.applyVideoConstraints({ advanced: [{ torch: torchOn }] }); torchButton.classList.toggle('active', torchOn); torchButton.textContent = torchOn ? '🔦 Lampe allumée' : '🔦 Lampe'; }
  catch { torchOn = false; message(scanMessage, 'La lampe n’est pas disponible avec cet appareil.', true); }
}
async function removeFood(id) {
  if (maintenanceBlocked()) return; const { error } = await supabase.from('food_items').delete().eq('id', id); if (error) return message(authMessage, 'Impossible de supprimer cet aliment.', true); loadFoods(); }
async function consumeFood(id) {
  if (maintenanceBlocked()) return;
  const { error } = await supabase.from('food_items').delete().eq('id', id);
  if (error) return message(authMessage, 'Impossible de marquer cet aliment comme consommé.', true);
  message(authMessage, 'Bon appétit ! Aliment retiré du frigo.');
  loadFoods();
}
async function changeQuantity(item, direction) {
  if (maintenanceBlocked()) return;
  const step = quantityStep(item), current = Number(item.quantity || 1);
  const next = Math.max(step, Math.round((current + direction * step) * 100) / 100);
  if (next === current) return;
  const { error } = await supabase.from('food_items').update({ quantity: next }).eq('id', item.id);
  if (error) return message(authMessage, 'Impossible de modifier la quantité.', true);
  loadFoods();
}
async function addToShopping(name) {
  if (maintenanceBlocked()) return;
  const { error } = await supabase.from('shopping_items').insert({ user_id: activeUserId, name });
  if (error) return message(authMessage, 'Impossible d’ajouter cet article : ' + error.message, true);
  message(authMessage, `« ${name} » a été ajouté à la liste de courses.`); loadShopping();
}
async function toggleShopping(id, checked) {
  if (maintenanceBlocked()) return;
  const { error } = await supabase.from('shopping_items').update({ checked }).eq('id', id);
  if (error) return message(authMessage, 'Impossible de mettre à jour la liste de courses.', true);
  loadShopping();
}
async function deleteShopping(id) {
  if (maintenanceBlocked()) return;
  const { error } = await supabase.from('shopping_items').delete().eq('id', id);
  if (error) return message(authMessage, 'Impossible de supprimer cet article.', true);
  loadShopping();
}

authForm.addEventListener('submit', async (event) => {
  event.preventDefault(); const { error } = await supabase.auth.signInWithOtp({ email: email.value.trim(), options: { emailRedirectTo: appUrl } });
  if (error) return message(authMessage, 'Impossible d’envoyer le code. Réessaie.', true);
  authCodeRow.hidden = false; authCode.value = ''; authCode.focus();
  message(authMessage, 'Code envoyé : saisis les 8 chiffres reçus. Pense aussi à vérifier tes spams.');
});
verifyAuthCode.addEventListener('click', async () => {
  const token = authCode.value.replace(/\s/g, '');
  if (!email.value.trim() || !/^\d{8}$/.test(token)) return message(authMessage, 'Entre les 8 chiffres reçus par e-mail.', true);
  verifyAuthCode.disabled = true; verifyAuthCode.textContent = '…';
  const { error } = await supabase.auth.verifyOtp({ email: email.value.trim(), token, type: 'email' });
  verifyAuthCode.disabled = false; verifyAuthCode.textContent = 'Me connecter';
  if (error) return message(authMessage, 'Code invalide ou expiré. Demande-en un nouveau.', true);
  message(authMessage, 'Connexion réussie.');
});
authCode.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); verifyAuthCode.click(); } });
$('#sign-out').addEventListener('click', () => supabase.auth.signOut());
adminLink?.addEventListener('click', () => { window.location.href = './admin.html'; });
deleteAccountButton.addEventListener('click', async () => {
  const approved = confirm('Supprimer définitivement ton compte, ton stock, ta liste de courses et ton calendrier ? Cette action est irréversible.');
  if (!approved) return;
  deleteAccountButton.disabled = true;
  deleteAccountButton.textContent = 'Suppression…';
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    deleteAccountButton.disabled = false;
    deleteAccountButton.textContent = 'Suppression';
    return alert('Ta session a expiré. Reconnecte-toi puis réessaie.');
  }
  const { error } = await supabase.functions.invoke('delete-account', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + session.access_token },
  });
  if (error) {
    deleteAccountButton.disabled = false;
    deleteAccountButton.textContent = 'Suppression';
    return alert('Impossible de supprimer ton compte pour le moment. Réessaie dans un instant.');
  }
  await supabase.auth.signOut();
  deleteAccountButton.disabled = false;
  deleteAccountButton.textContent = 'Suppression';
  alert('Ton compte et tes données ont bien été supprimés.');
});
showPrivacy.addEventListener('click', () => privacyDialog.showModal());
closePrivacy.addEventListener('click', () => privacyDialog.close());
privacyDialog.addEventListener('click', (event) => { if (event.target === privacyDialog) privacyDialog.close(); });
copyCalendarLink.addEventListener('click', async () => {
  await navigator.clipboard.writeText(calendarLink.value);
  copyCalendarLink.textContent = 'Copié !';
  setTimeout(() => { copyCalendarLink.textContent = 'Copier'; }, 1800);
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (maintenanceBlocked(foodMessage)) return;
  if (!form.reportValidity()) return;
  addFoodButton.disabled = true; addFoodButton.textContent = 'Ajout…';
  let error;
  try {
    ({ error } = await supabase.from('food_items').insert({ user_id: activeUserId, name: nameInput.value.trim(), expires_on: dateInput.value, barcode: barcodeInput.value || null, location: locationInput.value, quantity: quantityInput.value, unit: unitInput.value }));
  } catch {
    error = { message: 'Erreur de connexion' };
  }
  addFoodButton.disabled = false; updateAddButton();
  if (error) return message(foodMessage, 'Impossible d’ajouter cet aliment : ' + error.message, true);
  rememberPreference(barcodeInput.value);
  form.reset(); quantityInput.value = 1; await loadFoods(); await stopScanner(); if (foodDialog.open) foodDialog.close(); message(authMessage, 'Article ajouté à ton stock.');
  updateAddButton();
});
clearAll.addEventListener('click', async () => {
  if (maintenanceBlocked()) return;
  if (!confirm('Supprimer tous les aliments ?')) return;
  const { error } = await supabase.from('food_items').delete().in('id', entries.map((item) => item.id));
  if (error) return message(authMessage, 'Impossible de vider le frigo.', true); loadFoods();
});
shoppingForm.addEventListener('submit', async (event) => {
  event.preventDefault(); const name = shoppingName.value.trim();
  if (!name) return;
  await addToShopping(name); shoppingForm.reset(); shoppingName.focus();
});
clearBought.addEventListener('click', async () => {
  if (maintenanceBlocked()) return;
  const boughtIds = shoppingEntries.filter((item) => item.checked).map((item) => item.id);
  if (!boughtIds.length) return;
  const { error } = await supabase.from('shopping_items').delete().in('id', boughtIds);
  if (error) return message(authMessage, 'Impossible d’effacer les articles cochés.', true);
  loadShopping();
});
filterButtons.forEach((button) => button.addEventListener('click', () => {
  activeLocation = button.dataset.location;
  filterButtons.forEach((item) => { const selected = item === button; item.classList.toggle('active', selected); item.setAttribute('aria-pressed', String(selected)); });
  render();
}));
lookupButton.addEventListener('click', () => lookupProduct(barcodeInput.value));
barcodeInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); lookupProduct(barcodeInput.value); } });
scanButton.addEventListener('click', startScanner); torchButton.addEventListener('click', toggleTorch); dateInput.min = new Date().toISOString().slice(0, 10);
locationInput.addEventListener('change', updateAddButton); showCalendar.addEventListener('click', () => { calendarSetup.hidden = !calendarSetup.hidden; if (!calendarSetup.hidden) calendarSetup.scrollIntoView({ behavior: 'smooth', block: 'start' }); }); hideCalendar.addEventListener('click', () => { calendarSetup.hidden = true; }); updateAddButton();
addTrigger.addEventListener('click', () => { message(foodMessage, ''); foodDialog.showModal(); requestAnimationFrame(() => nameInput.focus()); });
closeAdd.addEventListener('click', async () => { await stopScanner(); foodDialog.close(); });
foodDialog.addEventListener('click', async (event) => { if (event.target === foodDialog) { await stopScanner(); foodDialog.close(); } });
await loadPublicSettings(); const { data: { session } } = await supabase.auth.getSession(); await setSession(session); supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
