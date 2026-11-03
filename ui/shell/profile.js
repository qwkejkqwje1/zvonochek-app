// Перенос профиля на другое устройство (компьютер или телефон): сохранить в файл под паролем, загрузить из файла (с перезапуском).
import { $, h, call, host, icon, dialog, confirmDialog, toast, fmtSize } from './lib.js';

const MIN = 8;
const DONE_KEY = 'zvProfileImported';

/** Диалог пароля; `run(password)` выполняется с блокировкой кнопок, ошибка показывается тут же. */
function passwordDialog({ title, text, note, fileName, repeat, okLabel, okIcon, run }) {
  return new Promise((res) => {
    let result = null;
    dialog(
      (b, close) => {
        const pw = h('input.field', { type: 'password', placeholder: 'Пароль', autocomplete: 'new-password', maxlength: 200 });
        const pw2 = repeat ? h('input.field', { type: 'password', placeholder: 'Пароль ещё раз', autocomplete: 'new-password', maxlength: 200 }) : null;
        const info = h('div.hint');
        const ok = h('button.btn.primary', { disabled: true }, okIcon ? icon(okIcon, 'sm') : null, okLabel);
        const cancel = h('button.btn.ghost', { onclick: () => close() }, 'Отмена');
        const valid = () => {
          const a = pw.value;
          if (a.length < MIN) return [false, a ? `Не короче ${MIN} символов` : ''];
          if (pw2 && pw2.value !== a) return [false, pw2.value ? 'Пароли не совпадают' : ''];
          return [true, ''];
        };
        const check = () => {
          const [v, msg] = valid();
          ok.disabled = !v;
          info.className = 'hint' + (msg ? ' bad' : '');
          info.textContent = msg;
        };
        const go = async () => {
          if (!valid()[0] || ok.disabled) return;
          ok.disabled = cancel.disabled = pw.disabled = true;
          if (pw2) pw2.disabled = true;
          info.className = 'hint';
          info.textContent = repeat ? 'Шифрую…' : 'Проверяю пароль…';
          try {
            result = await run(pw.value);
            close(true);
          } catch (e) {
            info.className = e?.cancel ? 'hint' : 'hint bad';
            info.textContent = e?.cancel ? '' : String(e?.message || e);
            ok.disabled = cancel.disabled = pw.disabled = false;
            if (pw2) pw2.disabled = false;
            pw.select();
          }
        };
        for (const i of [pw, pw2].filter(Boolean)) {
          i.addEventListener('input', check);
          i.addEventListener('keydown', (e) => e.key === 'Enter' && go());
        }
        ok.addEventListener('click', go);
        b.append(
          h('h3', title),
          text ? h('p', text) : null,
          fileName ? h('div.file-name.mono', fileName) : null,
          note ? h('div.note', note) : null,
          h('div.pw-row', pw, pw2),
          info,
          h('div.actions', cancel, ok)
        );
      },
      { onClose: () => res(result) }
    );
  });
}

async function exportProfile() {
  const r = await passwordDialog({
    title: 'Сохранить профиль в файл',
    text: 'В файл попадут ID устройства, контакты, ссылки, история звонков и переписка. Сами файлы из чатов не сохраняются.',
    note: 'Загрузите файл на новом устройстве, а здесь потом удалите приложение или не запускайте его: два устройства с одним профилем будут мешать друг другу. Пароль нужен для загрузки — восстановить его нельзя.',
    repeat: true,
    okLabel: 'Сохранить',
    okIcon: 'download',
    run: async (password) => {
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const name = `ZVONochek-профиль-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}.zvp`;
      const s = await call('host_save_path', { name });
      // отмена в системном диалоге — остаёмся в окне пароля
      if (host === 'tauri' && !s?.path) throw { cancel: true };
      return call('profile_export', { password, path: s?.path || undefined });
    },
  });
  if (!r) return;
  toast(`Профиль сохранён: ${r.name} (${fmtSize(r.size)})`, 4000);
  // телефон: файл — во внутренней папке приложения, дальше — «Поделиться» (в «Файлы», облако, мессенджер)
  const mobile = document.body.classList.contains('mobile');
  dialog((b, close) => {
    b.append(
      h('h3', 'Профиль сохранён'),
      h(
        'p',
        mobile
          ? 'Отправьте файл на новое устройство (облако, почта, мессенджер — кнопка «Поделиться») и загрузите его там: Настройки → Перенос на другое устройство → Загрузить.'
          : 'Перенесите файл на новое устройство (флешка, облако, почта) и загрузите его там: Настройки → Перенос на другое устройство → Загрузить.'
      ),
      h('div.file-name.mono.selectable', r.path),
      h(
        'div.actions',
        h(
          'button.btn',
          {
            onclick: () => call('host_open_path', { export: true, reveal: true }).catch((e) => toast('Не открылось: ' + (e.message || e))),
          },
          icon(mobile ? 'external' : 'folder', 'sm'),
          mobile ? 'Поделиться' : 'Показать в папке'
        ),
        h('button.btn.primary', { onclick: () => close() }, 'Готово')
      )
    );
  });
}

async function importProfile() {
  if (
    !(await confirmDialog(
      'Загрузить профиль из файла?',
      'Контакты, ссылки, история и переписка на этом устройстве заменятся данными из файла, приложение перезапустится.',
      'Выбрать файл'
    ))
  )
    return;
  const pick = await call('host_pick_files', { profile: true }).catch(() => null);
  const path = pick?.paths?.[0];
  if (!path) return;
  const fileName = path.split(/[\\/]/).pop();
  const r = await passwordDialog({
    title: 'Пароль от файла профиля',
    text: 'Введите пароль, который задали при сохранении.',
    fileName,
    okLabel: 'Загрузить',
    okIcon: 'upload',
    run: (password) => call('profile_import', { path, password }),
  });
  if (!r) return;
  try {
    localStorage.setItem(DONE_KEY, JSON.stringify({ name: r.name || '', contacts: r.contacts || 0, at: Date.now() }));
  } catch {}
  const res = await call('host_restart').catch(() => null);
  // в приложении сюда не дойдём (перезапуск); иначе — попросить перезапустить вручную
  if (!res?.restart) {
    dialog((b, close) => {
      b.append(
        h('h3', 'Профиль загружен'),
        h('p', 'Перезапустите приложение, чтобы закончить перенос.'),
        h('div.actions', h('button.btn.primary', { onclick: () => close() }, 'Понятно'))
      );
    });
  }
}

// ---------- пароль профиля (Windows): ключ данных под паролем — папку можно открыть на другом компьютере ----------
async function initVault() {
  let st = await call('vault_status').catch(() => null);
  if (!st || !st.enabled) return;
  const render = (s) => {
    st = s;
    $('#rowVault').classList.remove('hidden');
    $('#vaultText').textContent = s.password
      ? s.remember
        ? 'Задан. На этом компьютере не спрашивается, на других — при запуске'
        : 'Задан. Спрашивается при каждом запуске'
      : 'Не задан — профиль открывается только на этом компьютере. Задайте пароль, чтобы переносить папку с программой на другие';
    $('#vaultSet').lastChild.textContent = s.password ? 'Сменить' : 'Задать';
    $('#vaultDel').classList.toggle('hidden', !s.password);
    $('#rowVaultRemember').classList.toggle('hidden', !s.password);
    $('#vaultRemember').checked = !!s.remember;
  };
  render(st);
  $('#vaultSet').addEventListener('click', async () => {
    const had = st.password;
    const r = await passwordDialog({
      title: had ? 'Сменить пароль профиля' : 'Задать пароль профиля',
      text: 'С паролем папку ZVONochek-data можно унести на другой компьютер: там ZVONochek спросит пароль. Ключ устройства, контакты и ссылки зашифрованы.',
      note: 'Пароль нигде не хранится, восстановить его нельзя. Забудете — профиль откроется только на компьютерах, где он запомнен.',
      repeat: true,
      okLabel: had ? 'Сменить' : 'Задать',
      okIcon: 'lock',
      run: (password) => call('vault_set_password', { password }),
    });
    if (!r) return;
    render(r);
    toast(had ? 'Пароль профиля изменён' : 'Пароль профиля задан', 3000);
  });
  $('#vaultDel').addEventListener('click', async () => {
    if (
      !(await confirmDialog(
        'Убрать пароль профиля?',
        'Профиль будет открываться без пароля, но только на этом компьютере (и там, где он уже запомнен). Унести папку на другой компьютер будет нельзя.',
        'Убрать',
        true
      ))
    )
      return;
    try {
      render(await call('vault_remove_password'));
      toast('Пароль профиля убран', 3000);
    } catch (e) {
      toast('Не удалось: ' + (e.message || e), 6000);
    }
  });
  $('#vaultRemember').addEventListener('change', async (e) => {
    try {
      render(await call('vault_remember', { on: e.target.checked }));
      toast(e.target.checked ? 'На этом компьютере пароль спрашиваться не будет' : 'Пароль будет спрашиваться при каждом запуске', 3500);
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast('Не удалось: ' + (err.message || err), 6000);
    }
  });
}

/** После перезапуска с перенесённым профилем — сообщить один раз. */
export function initProfile() {
  initVault().catch(console.error);
  $('#profExport')?.addEventListener('click', () => exportProfile().catch((e) => toast('Не удалось: ' + (e.message || e))));
  $('#profImport')?.addEventListener('click', () => importProfile().catch((e) => toast('Не удалось: ' + (e.message || e))));
  let done = null;
  try {
    done = JSON.parse(localStorage.getItem(DONE_KEY) || 'null');
    localStorage.removeItem(DONE_KEY);
  } catch {}
  if (done && Date.now() - done.at < 10 * 60_000) {
    const n = done.contacts;
    const word = n % 10 === 1 && n % 100 !== 11 ? 'контакт' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'контакта' : 'контактов';
    setTimeout(() => toast(`Профиль перенесён${done.name ? ` («${done.name}»)` : ''}: ${n} ${word}`, 5000), 600);
  }
}
