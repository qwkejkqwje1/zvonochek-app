// Контакты: звонок напрямую между устройствами (P2P) — без ссылок.
// Сеть, ключи и хранение — в ядре (crates/zv-core/src/contacts.rs): contacts_list, contact_invite,
// contact_add, contact_call, contact_offer… Здесь — только страница «Контакты» и диалоги.
import {
  $,
  h,
  icon,
  call,
  on,
  initials,
  ago,
  toast,
  copyText,
  dialog,
  confirmDialog,
  promptDialog,
  menu,
  qrSvg,
  openCall,
} from './lib.js';

export const C = {
  list: [],
  offers: [],
  p2p: { enabled: true, running: false },
  p2pError: '',
  visible: false,
};
let onChange = () => {};
let presTimer = null;
let addWait = null; // открытый диалог «Добавить по коду», ждущий ответа

export const contactById = (id) => C.list.find((c) => c.id === id);
export const contactByPeer = (peer) => C.list.find((c) => c.peer === peer);

// ---------- загрузка и события ----------
export async function loadContacts() {
  const [list, offers, p2p] = await Promise.all([
    call('contacts_list').catch(() => []),
    call('contact_offers').catch(() => []),
    call('p2p_status').catch(() => null),
  ]);
  C.list = Array.isArray(list) ? list : [];
  C.offers = Array.isArray(offers) ? offers : [];
  if (p2p) C.p2p = p2p;
  renderContacts();
  onChange();
}

function wire() {
  on('contacts:', (ev, p) => {
    if (ev === 'contacts:presence' && p && p.id) {
      const c = contactById(p.id);
      if (c) {
        c.online = p.online;
        c.path = p.path;
        c.checking = false;
        if (p.online) c.lastSeen = Date.now();
        updatePresence(c);
      }
      return;
    }
    loadContacts().catch(console.error);
  });
  on('contact:', (ev, p) => {
    p = p || {};
    if (ev === 'contact:added') {
      const who = p.name || 'Собеседник';
      toast(p.via === 'invite' ? `«${who}» добавил(а) вас в контакты` : `«${who}» теперь в контактах`, 3500);
      if (addWait) addWait.done(p);
      loadContacts().catch(console.error);
    } else if (ev === 'contact:add_failed') {
      const msg =
        p.reason === 'expired'
          ? 'Код приглашения устарел — попросите у собеседника новый'
          : 'Не удалось связаться с пригласившим. У него должно быть запущено приложение — попробуйте ещё раз.';
      if (addWait) addWait.fail(msg);
      else toast(msg, 5000);
    } else if (ev === 'contact:offer') {
      toast(`«${p.name || 'Собеседник'}» предлагает обменяться контактами`, 4000);
      loadContacts().catch(console.error);
    } else if (ev === 'contact:offer_sent') {
      toast('Предложение отправлено — ждём ответа собеседника', 3500);
    } else if (ev === 'contact:offer_failed') {
      toast(p.error || 'Не удалось отправить предложение', 5000);
    } else if (ev === 'contact:offer_declined') {
      toast(`«${p.name || 'Собеседник'}» не принял(а) предложение`, 4000);
    }
  });
  on('p2p:', (ev, p) => {
    if (ev === 'p2p:error') C.p2pError = (p && p.error) || 'ошибка запуска';
    if (ev === 'p2p:ready') C.p2pError = '';
    if (ev === 'p2p:ready' || ev === 'p2p:error') loadContacts().catch(console.error);
  });
  on('ring:', (ev, p) => {
    if (ev !== 'ring:ended' || !p) return;
    const who = p.name || 'Контакт';
    const text =
      p.reason === 'declined'
        ? `«${who}» отклонил(а) звонок`
        : p.reason === 'dnd'
          ? `У «${who}» включено «Не беспокоить»`
          : `«${who}» не отвечает`;
    toast(text, 4000);
  });
}

export function initContacts(opts = {}) {
  onChange = opts.onChange || onChange;
  wire();
  $('#ctInviteBtn').addEventListener('click', () => inviteDialog());
  $('#ctAddBtn').addEventListener('click', () => addDialog());
  return loadContacts();
}

/// Страница видна: опрашиваем «в сети» (ядро проверяет соединением, не чаще раза в 20 с на контакт).
export function contactsVisible(v) {
  C.visible = v;
  clearInterval(presTimer);
  presTimer = null;
  if (!v) return;
  const poll = () =>
    call('contacts_presence')
      .then((list) => {
        if (Array.isArray(list)) {
          C.list = list;
          renderContacts();
        }
      })
      .catch(() => {});
  poll();
  presTimer = setInterval(poll, 12000);
}

// ---------- страница ----------
function presence(c) {
  if (c.online) return ['ok', c.path === 'relay' ? 'в сети · через ретранслятор' : 'в сети · напрямую'];
  if (c.online == null && c.checking) return ['warn', 'проверяем…'];
  if (c.online === false) return ['off', c.lastSeen ? `не в сети · был(а) ${ago(c.lastSeen)}` : 'не в сети'];
  return ['off', c.lastSeen ? `был(а) на связи ${ago(c.lastSeen)}` : 'ещё не созванивались'];
}

function updatePresence(c) {
  const row = document.querySelector(`[data-contact="${c.id}"]`);
  if (!row) return;
  const [cls, text] = presence(c);
  const dot = row.querySelector('.pres');
  if (dot) dot.className = 'pres ' + cls;
  const t = row.querySelector('[data-pres]');
  if (t) t.textContent = text;
}

function contactRow(c) {
  const [cls, text] = presence(c);
  return h(
    'div.item',
    { 'data-contact': c.id },
    h('div.av-wrap', h('div.av', initials(c.name)), h('span.pres', { class: cls, title: text })),
    h(
      'div.body',
      h(
        'div.title',
        h('span', c.name),
        c.verified ? h('span.vbadge', { title: 'Код безопасности сверен' }, icon('shield', 'sm')) : null
      ),
      h(
        'div.sub',
        h('span', { 'data-pres': '1' }, text),
        c.theirName && c.theirName !== c.name ? h('span', `· сам(а): «${c.theirName}»`) : null
      )
    ),
    h(
      'div.acts',
      h('button.btn.ghost.icon', { title: 'Позвонить', 'data-act': 'call', onclick: () => callContact(c, false) }, icon('phone')),
      h('button.btn.ghost.icon', { title: 'Видеозвонок', 'data-act': 'video', onclick: () => callContact(c, true) }, icon('video')),
      h('button.btn.ghost.icon', { title: 'Ещё', 'data-act': 'more', onclick: (e) => contactMenu(e.currentTarget, c) }, icon('more'))
    )
  );
}

export function renderContacts() {
  const page = $('#page-contacts');
  if (!page) return;
  // P2P выключен или не запустился
  const warn = $('#ctP2p');
  if (!C.p2p.enabled) {
    warn.replaceChildren(
      h(
        'div.row',
        h('div.grow', h('b', 'Прямые соединения выключены'), h('small', 'Без них контакты не работают: звонки контактам идут напрямую между устройствами.')),
        h('button.btn.primary', { onclick: () => call('settings_set', { patch: { p2p: true } }).catch((e) => toast(e.message || e)) }, 'Включить')
      )
    );
    warn.classList.remove('hidden');
  } else if (!C.p2p.running) {
    warn.replaceChildren(
      h('div', h('b', C.p2pError ? 'P2P не запустился' : 'P2P запускается…'), h('small', C.p2pError || 'Подождите несколько секунд.'))
    );
    warn.classList.remove('hidden');
  } else {
    warn.classList.add('hidden');
  }
  // предложения обменяться контактами
  $('#ctOffers').replaceChildren(
    ...C.offers.map((o) =>
      h(
        'div.card.offer',
        { 'data-offer': o.id },
        h('div.av', initials(o.name)),
        h('div.grow', h('b', o.name || 'Собеседник'), h('small', `предлагает обменяться контактами · ${ago(o.created)}`)),
        h('button.btn.ghost', { onclick: () => answerOffer(o, false) }, 'Отклонить'),
        h('button.btn.primary', { onclick: () => answerOffer(o, true) }, icon('check', 'sm'), 'Добавить')
      )
    )
  );
  const list = [...C.list].sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || a.name.localeCompare(b.name, 'ru'));
  $('#ctList').replaceChildren(
    ...(list.length
      ? list.map(contactRow)
      : [
          h(
            'div.empty',
            icon('users'),
            h('div', 'Контактов пока нет.'),
            h('div.muted', 'Нажмите «Пригласить» и отправьте код собеседнику — или вставьте код, который прислали вам.')
          ),
        ])
  );
}

// ---------- звонок ----------
export async function callContact(c, video) {
  try {
    const r = await call('contact_call', { id: c.id, video: !!video });
    await openCall(r.secret, { dir: 'out', contact: c.name, video: !!video });
  } catch (e) {
    toast('Не удалось позвонить: ' + (e.message || e), 4000);
  }
}

function contactMenu(anchor, c) {
  menu(anchor, [
    { icon: 'phone', label: 'Позвонить', run: () => callContact(c, false) },
    { icon: 'video', label: 'Видеозвонок', run: () => callContact(c, true) },
    {
      icon: 'edit',
      label: 'Переименовать',
      run: async () => {
        const n = await promptDialog('Имя контакта', c.name, { label: 'Видно только вам.' });
        if (n) call('contact_update', { id: c.id, name: n }).catch((e) => toast(e.message || e));
      },
    },
    { icon: 'shield', label: 'Код безопасности', run: () => safetyDialog(c) },
    {
      icon: 'trash',
      label: 'Удалить',
      danger: true,
      run: async () => {
        if (
          await confirmDialog(
            `Удалить «${c.name}» из контактов?`,
            'Звонить друг другу напрямую будет нельзя, пока снова не обменяетесь контактами.',
            'Удалить',
            true
          )
        )
          call('contact_delete', { id: c.id }).catch((e) => toast(e.message || e));
      },
    },
  ]);
}

function safetyDialog(c) {
  if (!c.safety) {
    toast('Код появится, когда запустится P2P');
    return;
  }
  dialog((b, close) => {
    b.append(
      h('h3', 'Код безопасности'),
      h(
        'p',
        `Сравните код с «${c.name}» — голосом в звонке или при встрече. У вас обоих он должен быть одинаковым: значит, вы связаны напрямую и никто не подменил ключи.`
      ),
      h('div.safety', h('div.emoji', c.safety.emoji), h('div.digits.mono', c.safety.digits)),
      c.verified ? h('div.hint.ok', { style: { textAlign: 'center' } }, 'Вы уже отметили код как совпадающий') : null,
      h(
        'div.actions',
        h('button.btn.ghost', { onclick: () => close() }, 'Закрыть'),
        c.verified
          ? h(
              'button.btn',
              {
                onclick: () => {
                  close();
                  call('contact_update', { id: c.id, verified: false }).catch((e) => toast(e.message || e));
                },
              },
              'Снять отметку'
            )
          : h(
              'button.btn.primary',
              {
                onclick: () => {
                  close();
                  call('contact_update', { id: c.id, verified: true })
                    .then(() => toast('Контакт отмечен как проверенный'))
                    .catch((e) => toast(e.message || e));
                },
              },
              icon('check', 'sm'),
              'Совпадает'
            )
      )
    );
  });
}

// ---------- приглашение ----------
const fmtDate = (ms) => new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

export async function inviteDialog() {
  let inv;
  try {
    inv = await call('contact_invite', {});
  } catch (e) {
    toast('Приглашение недоступно: ' + (e.message || e), 4000);
    return;
  }
  const st = await call('settings_get').catch(() => ({}));
  dialog((b, close) => {
    const body = h('div');
    const draw = () => {
      const svg = qrSvg(inv.url, 'L');
      body.replaceChildren(
        h(
          'p',
          'Отправьте код тому, с кем хотите созваниваться без ссылок. Он вставит его в ZVONochek («Контакты» → «Добавить по коду») — и вы появитесь друг у друга в контактах.'
        ),
        st.name
          ? null
          : h('div.hint.bad', { style: { marginBottom: '10px' } }, 'Укажите своё имя в настройках — его увидит собеседник.'),
        h(
          'div.linkbox',
          h('span.mono.selectable', { 'data-code': '1' }, inv.code),
          h('button.btn.sm.primary', { onclick: () => copyText(inv.code, 'Код скопирован') }, icon('copy', 'sm'), 'Копировать')
        ),
        svg ? h('div.qr', { html: svg, title: 'Для телефона: отсканируйте камерой' }) : null,
        h(
          'div.muted',
          { style: { textAlign: 'center', fontSize: '12.5px' } },
          `Код многоразовый, действует до ${fmtDate(inv.expires)}. Добавиться можно, пока у вас запущено приложение.`
        )
      );
    };
    draw();
    b.append(
      h('h3', 'Пригласить в контакты'),
      body,
      h(
        'div.actions',
        h(
          'button.btn.ghost',
          {
            title: 'Старый код перестанет работать',
            onclick: async () => {
              if (!(await confirmDialog('Создать новый код?', 'Старый код перестанет работать — те, кто ещё не добавился, не смогут им воспользоваться.', 'Создать')))
                return;
              try {
                inv = await call('contact_invite', { renew: true });
                draw();
                toast('Новый код создан');
              } catch (e) {
                toast(e.message || e);
              }
            },
          },
          icon('refresh', 'sm'),
          'Новый код'
        ),
        h('button.btn.primary', { onclick: () => close() }, 'Готово')
      )
    );
  });
}

// ---------- добавление по коду ----------
export function addDialog(prefill = '') {
  dialog(
    (b, close) => {
      const ta = h('textarea.field.code', { placeholder: 'zv4c:…', rows: 3, spellcheck: 'false' });
      ta.value = prefill;
      const info = h('div.hint');
      const nm = h('input.field', { placeholder: 'Как подписать контакт', maxlength: 60 });
      const ok = h('button.btn.primary', { disabled: true }, icon('userplus', 'sm'), 'Добавить');
      let parsed = null;
      let seq = 0;
      let nameTouched = false;
      nm.addEventListener('input', () => (nameTouched = true));
      const check = async () => {
        const text = ta.value.trim();
        const my = ++seq;
        if (!text) {
          parsed = null;
          info.textContent = '';
          info.className = 'hint';
          ok.disabled = true;
          return;
        }
        const r = await call('link_parse', { text }).catch(() => ({ kind: 'none' }));
        if (my !== seq) return;
        parsed = r;
        if (r.kind === 'contact') {
          const expired = r.expires && r.expires < Date.now();
          info.className = expired ? 'hint bad' : 'hint ok';
          info.textContent = expired
            ? 'Срок действия кода истёк — попросите у собеседника новый'
            : `Приглашение от «${r.name || 'без имени'}»`;
          if (!nameTouched) nm.value = r.name || '';
          ok.disabled = !!expired;
        } else {
          info.className = 'hint bad';
          info.textContent = r.kind === 'call' ? 'Это ссылка на звонок, а не код контакта' : 'Не похоже на код приглашения ZVONochek';
          ok.disabled = true;
        }
      };
      ta.addEventListener('input', check);
      const setBusy = (busy, text) => {
        ok.disabled = busy;
        ta.disabled = busy;
        nm.disabled = busy;
        if (text != null) {
          info.className = busy ? 'hint' : 'hint bad';
          info.textContent = text;
        }
      };
      ok.addEventListener('click', async () => {
        if (!parsed || parsed.kind !== 'contact') return;
        setBusy(true, `Связываемся с «${parsed.name || 'собеседником'}»…`);
        try {
          await call('contact_add', { code: ta.value.trim(), name: nm.value.trim() });
          addWait = {
            done: () => {
              addWait = null;
              close(true);
            },
            fail: (msg) => {
              addWait = null;
              setBusy(false, msg);
            },
          };
        } catch (e) {
          setBusy(false, e.message || String(e));
        }
      });
      b.append(
        h('h3', 'Добавить по коду'),
        h('p', 'Вставьте код приглашения, который вам прислали (начинается с zv4c:).'),
        ta,
        info,
        h('div', { style: { marginTop: '10px' } }, nm),
        h('div.actions', h('button.btn.ghost', { onclick: () => close() }, 'Отмена'), ok)
      );
      if (prefill) setTimeout(check, 0);
      else
        navigator.clipboard
          ?.readText?.()
          .then((t) => {
            if (!ta.value && /^\s*(zv4c:|zvonochek:\/\/contact)/.test(t || '')) {
              ta.value = t.trim();
              check();
            }
          })
          .catch(() => {});
    },
    { onClose: () => (addWait = null) }
  );
}

// ---------- предложения ----------
async function answerOffer(o, accept) {
  let name = o.name;
  if (accept) {
    name = await promptDialog('Добавить в контакты', o.name || '', { label: 'Как подписать контакт (видно только вам).', okLabel: 'Добавить' });
    if (name == null) return;
  }
  try {
    await call('contact_offer_answer', { offerId: o.id, accept, name: name || o.name });
    if (!accept) toast('Предложение отклонено');
  } catch (e) {
    toast(e.message || e, 4000);
  }
  loadContacts().catch(console.error);
}

/// Из истории: предложить собеседнику по недавнему звонку обменяться контактами.
export async function offerContact(peerId, name) {
  const n = await promptDialog('Добавить в контакты', name || '', {
    label: 'Собеседнику придёт предложение обменяться контактами — он должен быть в сети. Имя видно только вам.',
    okLabel: 'Отправить',
  });
  if (n == null) return;
  try {
    await call('contact_offer', { peerId, name: n || name || 'Собеседник' });
    toast('Отправляем предложение…');
  } catch (e) {
    toast(e.message || e, 4000);
  }
}
