// Входящие звонки (по «Моим ссылкам», от контактов и групповые): карточки с «Ответить»/«Отклонить» и мелодия.
// Tauri на ПК — отдельное всплывающее окно (incoming.html); Android и zv-devhost — поверх главного окна
// (Android, пока приложение свёрнуто, звонит уведомлением — см. ZvService.kt, а карточка молчит).
import { call, on, h, icon, initials, openCall, Ringer, toast } from './lib.js';

export function mountIncoming(root, { popup = false, mobile = false } = {}) {
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

  // звонок контакта или группы: камера — как у звонящего, можно ответить без видео
  const direct = (c) => !!(c.contactId || c.groupId);
  const render = () => {
    root.replaceChildren(
      ...[...calls.values()]
        .sort((a, b) => a.started - b.started)
        .map((c) =>
          h(
            'div.inc-card',
            { 'data-call': c.callId },
            h('div.inc-av', c.groupId ? icon('users') : initials(c.name || '?')),
            h(
              'div.inc-body',
              h('b', c.groupName || c.name || 'Без имени'),
              c.groupId
                ? h(
                    'small',
                    `${c.busy ? 'Вторая линия · ' : ''}${c.video ? 'Групповой видеозвонок' : 'Групповой звонок'} · ${c.name || 'участник'}`
                  )
                : c.contactId
                  ? h('small', `${c.busy ? 'Вторая линия · ' : ''}${c.video ? 'Видеозвонок' : 'Аудиозвонок'} · контакт`)
                  : h('small', c.busy ? `Вторая линия · ${c.linkName}` : `Звонит по ссылке «${c.linkName}»`),
              c.contactId || c.groupId ? null : h('small', c.app ? 'из приложения ZVONochek' : 'из браузера')
            ),
            h(
              'div.inc-acts',
              h(
                'button.round.bad',
                { title: 'Отклонить', 'aria-label': 'Отклонить', onclick: () => decline(c.callId) },
                icon('hangup')
              ),
              direct(c) && c.video
                ? h(
                    'button.round.ok.alt',
                    { title: 'Ответить без видео', 'aria-label': 'Ответить без видео', onclick: () => answer(c.callId, false) },
                    icon('phone')
                  )
                : null,
              h(
                'button.round.ok',
                {
                  title: c.busy ? 'Ответить (текущий звонок завершится)' : direct(c) && c.video ? 'Ответить с видео' : 'Ответить',
                  'aria-label': 'Ответить',
                  onclick: () => answer(c.callId),
                },
                icon(direct(c) && c.video ? 'video' : 'phone')
              )
            )
          )
        )
    );
    root.classList.toggle('hidden', calls.size === 0);
    if (calls.size && !dnd && !(mobile && document.hidden)) ringer.start(volume);
    else ringer.stop();
    if (popup && calls.size === 0) call('host_incoming_empty').catch(() => {});
  };

  async function answer(callId, withVideo) {
    ringer.stop();
    try {
      const r = await call('call_answer', { callId });
      const boot = { dir: 'in', peer: r.groupName || r.name, replace: true };
      // контакт и группа: камера — как у звонящего (или без видео по выбору); ссылки — как раньше.
      // У группы нет boot.contact: окно звонка не закрывается, когда уходит один из участников.
      if (r.contactId) Object.assign(boot, { contact: r.name, video: withVideo ?? !!r.video });
      else if (r.groupId) boot.video = withVideo ?? !!r.video;
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
  if (mobile) document.addEventListener('visibilitychange', () => calls.size && render());
  refreshSettings().then(async () => {
    try {
      for (const c of await call('incoming_list')) calls.set(c.callId, c);
    } catch {}
    render();
  });
  return { answer, decline, count: () => calls.size };
}
