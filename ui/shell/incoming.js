// Входящие звонки по «Моим ссылкам»: карточки с «Ответить»/«Отклонить» и мелодия.
// Tauri — отдельное всплывающее окно (incoming.html); zv-devhost — поверх главного окна.
import { call, on, h, icon, initials, openCall, Ringer, toast } from './lib.js';

export function mountIncoming(root, { popup = false } = {}) {
  const calls = new Map();
  const ringer = new Ringer();
  let volume = 0.8;
  let dnd = false;

  const refreshSettings = async () => {
    try {
      const st = await call('settings_get');
      volume = (st.ringVolume ?? 80) / 100;
      dnd = !!st.dnd;
    } catch {}
  };

  const render = () => {
    root.replaceChildren(
      ...[...calls.values()]
        .sort((a, b) => a.started - b.started)
        .map((c) =>
          h(
            'div.inc-card',
            { 'data-call': c.callId },
            h('div.inc-av', initials(c.name || '?')),
            h(
              'div.inc-body',
              h('b', c.name || 'Без имени'),
              c.contactId
                ? h('small', `${c.busy ? 'Вторая линия · ' : ''}${c.video ? 'Видеозвонок' : 'Аудиозвонок'} · контакт`)
                : h('small', c.busy ? `Вторая линия · ${c.linkName}` : `Звонит по ссылке «${c.linkName}»`),
              c.contactId ? null : h('small', c.app ? 'ZVONochek для ПК' : 'из браузера')
            ),
            h(
              'div.inc-acts',
              h(
                'button.round.bad',
                { title: 'Отклонить', 'aria-label': 'Отклонить', onclick: () => decline(c.callId) },
                icon('hangup')
              ),
              c.contactId && c.video
                ? h(
                    'button.round.ok.alt',
                    { title: 'Ответить без видео', 'aria-label': 'Ответить без видео', onclick: () => answer(c.callId, false) },
                    icon('phone')
                  )
                : null,
              h(
                'button.round.ok',
                {
                  title: c.busy ? 'Ответить (текущий звонок завершится)' : c.contactId && c.video ? 'Ответить с видео' : 'Ответить',
                  'aria-label': 'Ответить',
                  onclick: () => answer(c.callId),
                },
                icon(c.contactId && c.video ? 'video' : 'phone')
              )
            )
          )
        )
    );
    root.classList.toggle('hidden', calls.size === 0);
    if (calls.size && !dnd) ringer.start(volume);
    else ringer.stop();
    if (popup && calls.size === 0) call('host_incoming_empty').catch(() => {});
  };

  async function answer(callId, withVideo) {
    ringer.stop();
    try {
      const r = await call('call_answer', { callId });
      const boot = { dir: 'in', peer: r.name, replace: true };
      // контакт: камера — как у звонящего (или без видео по выбору); ссылки — как раньше
      if (r.contactId) Object.assign(boot, { contact: r.name, video: withVideo ?? !!r.video });
      await openCall(r.secret, boot);
    } catch (e) {
      toast('Не удалось ответить: ' + (e.message || e));
    }
  }
  async function decline(callId) {
    try {
      await call('call_decline', { callId });
    } catch {}
  }

  on('call:', (ev, p) => {
    if (ev === 'call:incoming' || ev === 'call:update') {
      calls.set(p.callId, p);
      render();
    } else if (ev === 'call:ended') {
      calls.delete(p.callId);
      render();
    }
  });
  on('settings:', () => refreshSettings().then(render));
  refreshSettings().then(async () => {
    try {
      for (const c of await call('incoming_list')) calls.set(c.callId, c);
    } catch {}
    render();
  });
  return { answer, decline, count: () => calls.size };
}
