const API = '/api/puto-trabajo';

const STATUS_LABELS = {
    draft: 'Черновик', applied: 'Отклик', test_task: 'Тестовое', interview: 'Интервью', offer: 'Оффер',
    rejected: 'Отказ', no_response: 'Нет ответа', withdrawn: 'Снят', on_hold: 'На паузе',
};
// Ступень = докуда дошёл отклик. Пустая строка — дальше отправки не уехал; отказ её не
// сбрасывает, поэтому «отказ после финала» и «отказ по резюме» в воронке видно отдельно.
const STAGE_LABELS = {
    '': 'Дальше отклика не ушло', screening: 'Был скрининг', tech: 'Был техсобес',
    final: 'Был финал', offer: 'Был оффер',
};
// Пока идёт интервью, тот же вопрос звучит проще: какое интервью назначено. Это и есть
// ступень — назначили техсобес, значит до техсобеса дошли.
const INTERVIEW_TYPES = { screening: 'Скрининг', tech: 'Техсобес', final: 'Финал' };
// Статусы, у которых «докуда дошло» ещё о чём-то говорит. У отклика без ответа ступень
// всегда пустая, а оффер бэкенд проставляет сам, — там селектор только путал бы.
const OUTCOME_STATUSES = ['rejected', 'no_response', 'withdrawn', 'on_hold'];

// Поле ступени под выбранный статус: подпись и <select>, или пусто, если спрашивать нечего.
function stageFieldHtml(status, stage, cls) {
    const pick = (labels, current) => Object.entries(labels)
        .map(([v, l]) => `<option value="${v}"${current === v ? ' selected' : ''}>${l}</option>`)
        .join('');
    if (status === 'interview') {
        return `<label>Какое интервью назначено</label>
            <select class="${cls}">${pick(INTERVIEW_TYPES, INTERVIEW_TYPES[stage] ? stage : 'screening')}</select>`;
    }
    if (OUTCOME_STATUSES.includes(status)) {
        return `<label>Докуда дошло</label>
            <select class="${cls}">${pick(STAGE_LABELS, stage || '')}</select>`;
    }
    return '';
}

// Рисует поле ступени в box и держит выбор при переключении статуса туда-обратно.
// Возвращает геттер: ступень или undefined, если поля нет — тогда ключ в PATCH не уходит
// и бэкенд оставляет ступень как была.
function mountStageField(box, statusSelect, stage) {
    let picked = stage || '';
    const draw = () => {
        box.innerHTML = stageFieldHtml(statusSelect.value, picked, 'stage-select');
        box.classList.toggle('hidden', !box.innerHTML);
        const select = box.querySelector('select');
        if (select) select.addEventListener('change', () => { picked = select.value; });
    };
    draw();
    statusSelect.addEventListener('change', draw);
    return () => box.querySelector('select')?.value;
}

const JOB_STATUS_LABELS = {
    new: 'Новая', ranked: 'Оценена', shortlisted: 'Шорт-лист',
    dismissed: 'Отклонена', applied: 'В трекере',
};

let applications = [];
let jobs = [];
let sortKey = 'date';
let sortDir = -1;
let pollTimer = null;

function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }

// Форма слова без самого числа — когда число уже стоит рядом крупным шрифтом.
function pluralWord(n, one, few, many) {
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 14) return many;
    const mod10 = n % 10;
    if (mod10 === 1) return one;
    if (mod10 >= 2 && mod10 <= 4) return few;
    return many;
}

function plural(n, one, few, many) {
    return `${n} ${pluralWord(n, one, few, many)}`;
}

function toast(msg, isError) {
    document.querySelectorAll('.toast').forEach(t => t.remove());
    const el = document.createElement('div');
    el.className = 'toast' + (isError ? ' err' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), isError ? 6000 : 3000);
}

async function api(path, options = {}) {
    const res = await fetch(API + path, {
        headers: { 'Content-Type': 'application/json' }, ...options,
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* empty body */ }
    // 403 здесь значит одно из двух — сессия протухла или аккаунт не в списке доступа.
    // Что именно, знает /api/auth/check; он же поднимет экран входа с нужным текстом.
    if (res.status === 403) checkAuth();
    if (!res.ok) throw new Error((data && data.error) || `Ошибка ${res.status}`);
    return data;
}

// ------------------------------------------------------------------ вход

// Two ways in, chosen by the server: the Telegram widget (default) or a password form —
// /api/auth/check says which ("method"). The widget needs the bot's username, which the
// same answer names when the deployment configures one; there is no default.
let TG_BOT = '';
let authGateShown = false;

// true — можно работать. false — экран входа уже на экране, грузить ничего не надо.
async function checkAuth() {
    let data = null;
    try {
        const res = await fetch('/api/auth/check');
        data = await res.json().catch(() => null);
    } catch (e) {
        return true;  // сеть лежит — пусть обычные запросы сами расскажут, что не так
    }
    if (data && data.bot) TG_BOT = data.bot;
    if (!data || !data.authenticated) {
        if (data && data.method === 'password') showPasswordGate();
        else showAuthGate();
        return false;
    }
    // Кнопка логина тут не поможет: аккаунт есть, доступа нет.
    if (!data.whitelisted) { showAuthGate('Этот аккаунт Telegram не в списке доступа.', false); return false; }
    return true;
}

function showAuthGate(message, withWidget = true) {
    if (authGateShown) return;
    authGateShown = true;
    stopPolling();
    if (message) document.getElementById('auth-msg').textContent = message;
    if (withWidget) {
        const box = document.getElementById('telegram-login');
        const script = document.createElement('script');
        script.src = 'https://telegram.org/js/telegram-widget.js?22';
        script.setAttribute('data-telegram-login', TG_BOT);
        script.setAttribute('data-size', 'large');
        script.setAttribute('data-radius', '8');
        script.setAttribute('data-onauth', 'onTelegramAuth(user)');
        script.setAttribute('data-request-access', 'write');
        box.appendChild(script);
    }
    document.getElementById('auth-gate').classList.remove('hidden');
}

function showPasswordGate() {
    if (authGateShown) return;
    authGateShown = true;
    stopPolling();
    document.getElementById('auth-msg').textContent = 'Введи пароль — и останешься на этой же странице.';
    const box = document.getElementById('telegram-login');
    box.innerHTML = `<form class="auth-form">
        <input type="password" name="password" placeholder="Пароль" autocomplete="current-password" required autofocus>
        <button class="btn" type="submit">Войти</button>
    </form>`;
    box.querySelector('form').addEventListener('submit', async event => {
        event.preventDefault();
        const button = event.target.querySelector('button');
        button.disabled = true;
        try {
            const res = await fetch('/api/auth/password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: event.target.password.value }),
            });
            if (res.ok) { location.reload(); return; }
            const data = await res.json().catch(() => ({}));
            toast(data.error || 'Не удалось войти', true);
            event.target.password.select();
        } catch (e) {
            toast('Не удалось войти: ' + e.message, true);
        }
        button.disabled = false;
    });
    document.getElementById('auth-gate').classList.remove('hidden');
}

// Фоновые опросы за экраном входа только сыпали бы 403 в цикле.
function stopPolling() {
    [pollTimer, dockTimer, chatTimer].forEach(t => { if (t) clearInterval(t); });
    pollTimer = dockTimer = chatTimer = null;
}

window.onTelegramAuth = async function (user) {
    try {
        const res = await fetch('/api/auth/telegram', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(user),
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            toast(data.error || 'Не удалось войти', true);
            return;
        }
    } catch (e) {
        toast('Не удалось войти: ' + e.message, true);
        return;
    }
    // Перезагрузка, а не «дособрать состояние руками»: пол-экрана уже отрисовалось
    // пустым после 403. Хэш в URL переживает reload, так что вкладка та же.
    location.reload();
};

// ------------------------------------------------------------------ tabs & routing

// The open tab and the job whose /apply chat is open live in the URL hash, so a reload
// (or a shared link) lands back where you were. Hash rather than a real path: the app is
// served as a static file, so a deep path would 404 on reload.
// Shape: #/search — tab only; #/search?job=622 — that tab with job 622's chat open;
// #/search?chat=41 — open chat 41 once (push notifications link there);
// #/search?focus=622,630 — scroll to and highlight those jobs once (the rank push).
const TABS = ['tracker', 'search', 'docs'];
let currentTab = TABS[0];
// Jobs a ?focus= link asked for, consumed by the next renderJobs that can show them.
let focusJobIds = null;
// Set while applying the URL to the page, so the resulting tab/chat changes don't write
// the URL back and fight the history entry we are currently navigating to.
let applyingUrl = false;

function readUrlState() {
    const [tab, query] = location.hash.replace(/^#\/?/, '').split('?');
    const params = new URLSearchParams(query || '');
    const job = Number(params.get('job'));
    const chat = Number(params.get('chat'));
    const focus = (params.get('focus') || '').split(',').map(Number).filter(n => n > 0);
    return { tab: TABS.includes(tab) ? tab : TABS[0], job: job > 0 ? job : null,
             chat: chat > 0 ? chat : null, focus: focus.length ? focus : null };
}

function syncUrl(replace) {
    if (applyingUrl) return;
    const hash = `#/${currentTab}` + (chatJobId ? `?job=${chatJobId}` : '');
    if (hash === location.hash) return;
    history[replace ? 'replaceState' : 'pushState'](null, '', hash);
}

function showTab(name) {
    currentTab = name;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    TABS.forEach(n => document.getElementById('tab-' + n).classList.toggle('hidden', n !== name));
    if (name === 'search') { loadJobs(); loadRuns(); }
    if (name === 'docs') loadDocs();
}

async function applyUrlState() {
    const state = readUrlState();
    applyingUrl = true;
    try {
        if (state.focus) {
            focusJobIds = new Set(state.focus);
            // The status dropdown filters server-side, so a focused job outside it would
            // never even reach renderJobs. The default view holds every fresh ranking.
            document.getElementById('jobs-filter').value = '';
        }
        if (state.tab !== currentTab) showTab(state.tab);
        else if (state.focus && state.tab === 'search') loadJobs();
        if (state.job) {
            if (state.job !== chatJobId) await openChatForJob(state.job, false);
        } else if (state.chat) {
            // One-shot: syncUrl below never writes ?chat= back, so the link opens the chat
            // and then reads as the plain tab — same as a chat opened from the dock.
            if (state.chat !== chatId) { chatJobId = null; await openChat(state.chat); }
        } else if (chatJobId) closeModal();
    } finally {
        applyingUrl = false;
        // Reconcile: a job id that no longer resolves left the chat closed, and the stale
        // ?job= should not survive the next reload. replaceState — this is not a new step.
        syncUrl(true);
    }
}

document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        if (tab.dataset.tab === currentTab) return;
        showTab(tab.dataset.tab);
        syncUrl();
    });
});

// Back/forward: pushState alone fires neither event, so popstate is the whole story here.
window.addEventListener('popstate', applyUrlState);

// ------------------------------------------------------------------ направления поиска

// Один переключатель на все вкладки: в трекере он смотрит на роль отклика, в поиске — на
// заголовок вакансии. Направления задаются в config.yaml (puto_trabajo.tracks): у каждого
// список правил «совпало match и не совпало unless», хватает одного. Роль может попасть в
// два направления сразу или ни в одно — тогда она видна только в «Все». Без направлений
// переключателя нет вовсе.
let TRACKS = {};
let jobTrack = '';

async function loadTracks() {
    let tracks = [];
    try { tracks = (await api('/profile')).tracks || []; } catch (e) { /* без направлений */ }
    TRACKS = {};
    for (const t of tracks) {
        const rules = (t.rules || []).map(r => {
            try {
                return { match: new RegExp(r.match, 'i'), unless: r.unless ? new RegExp(r.unless, 'i') : null };
            } catch (e) { return null; }
        }).filter(Boolean);
        TRACKS[t.id] = title => rules.some(r => r.match.test(title) && !(r.unless && r.unless.test(title)));
    }
    jobTrack = localStorage.getItem('pt-job-track') || '';
    if (!(jobTrack in TRACKS)) jobTrack = '';
    document.querySelectorAll('.seg[data-tracks]').forEach(box => {
        box.classList.toggle('hidden', !tracks.length);
        box.innerHTML = tracks.map(t => `<button type="button" data-track="${esc(t.id)}"
            title="${esc(t.hint || '')}">${esc(t.label || t.id)}</button>`).join('')
            + '<button type="button" data-track="">All</button>';
        box.querySelectorAll('[data-track]').forEach(b => b.addEventListener('click', () => {
            jobTrack = b.dataset.track;
            localStorage.setItem('pt-job-track', jobTrack);
            renderTracker();
            renderFunnel();
            renderStats();
            renderJobs();
            renderDocs();
        }));
    });
}

function inTrack(title, track = jobTrack) {
    return !track || !TRACKS[track] || TRACKS[track](title || '');
}

// Счётчик на кнопке — по списку своей вкладки: откликам в трекере, вакансиям в поиске.
function renderTrackSwitch(box, titles) {
    box.querySelectorAll('[data-track]').forEach(b => {
        const track = b.dataset.track;
        b.classList.toggle('on', track === jobTrack);
        b.setAttribute('aria-pressed', String(track === jobTrack));
        b.textContent = `${b.textContent.replace(/\s*\d+$/, '')} ${
            titles.filter(t => inTrack(t, track)).length}`;
    });
}

// ------------------------------------------------------------------ tracker

let jobsPending = null;

async function loadStats() {
    try {
        jobsPending = (await api('/stats')).jobs_pending;
    } catch (e) { /* stats are decorative */ }
    renderStats();
}

// Плитки считаются из того же списка, что таблица и воронка, — иначе Analyst/Engineer
// резал бы строки, а цифры сверху оставались бы общими. «Дошли до интервью» — то же
// правило, что в /stats: ever_interview из журнала плюс достроенная ступень.
function renderStats() {
    const list = applications.filter(a => inTrack(a.role));
    const count = status => list.filter(a => a.status === status).length;
    const reached = list.filter(a => a.ever_interview || a.stage).length;
    document.getElementById('stats').innerHTML = `
        <div class="stat"><div class="value">${list.length}</div><div class="label">всего откликов</div></div>
        <div class="stat"><div class="value">${count('interview')}</div><div class="label">сейчас на интервью</div></div>
        <div class="stat"><div class="value">${count('rejected')}</div><div class="label">отказов</div></div>
        <div class="stat"><div class="value">${list.length ? Math.round(reached / list.length * 100) : 0}%</div><div class="label">доходят до интервью</div></div>
        ${jobsPending == null ? '' : `<div class="stat"><div class="value">${jobsPending}</div><div class="label">вакансий в очереди</div></div>`}`;
}

// Откуда пришла вакансия. channel заполняли по-разному в разные времена: коды фидов
// («freehire-spain:whatjobs-es», «lever:lodgify»), свободный текст («Docplanner careers
// (Ashby)», «Referral») и «manual» у добавленных руками. Сводим к короткому ярлыку для
// столбца, исходную строку оставляем в подсказке.
const SOURCE_FEEDS = {
    remotive: 'Remotive', arbeitnow: 'Arbeitnow', jobicy: 'Jobicy', himalayas: 'Himalayas',
    wwr: 'We Work Remotely', remoteok: 'RemoteOK', freehire: 'freehire',
};
const SOURCE_BOARDS = ['gh', 'greenhouse', 'lever', 'ashby', 'workable', 'recruitee'];

function sourceInfo(app) {
    const channel = (app.channel || '').trim();
    const lower = channel.toLowerCase();
    let host = '';
    try { host = new URL(app.source).hostname.replace(/^www\./, ''); } catch (e) { /* no url */ }
    const title = [channel, host].filter(Boolean).join(' · ');
    const [feed, sub] = lower.split(':');
    if (/linkedin/.test(lower) || /linkedin\./.test(host)) return { label: 'LinkedIn', title };
    if (/referr|рекоменд/.test(lower)) return { label: 'Рекомендация', title };
    if (sub !== undefined && SOURCE_BOARDS.includes(feed)) return { label: 'Скан досок', title };
    if (sub !== undefined || SOURCE_FEEDS[feed]) {
        const base = Object.keys(SOURCE_FEEDS).find(k => feed === k || feed.startsWith(k + '-'));
        if (base) return { label: SOURCE_FEEDS[base], title };
        if (feed.startsWith('tg-')) return { label: 'Telegram', title };
    }
    // Названный ATS — это та же страница вакансий компании, просто на чужом хостинге.
    if (/careers|direct|сайт|greenhouse|lever|ashby|workable|teamtailor|personio|breezy|factorial|rippling|recruitee|smartrecruiters/.test(lower)) {
        return { label: 'Сайт компании', title };
    }
    if (!channel || lower === 'manual' || lower === 'outside workflow') {
        return { label: host.includes('whatjobs') ? 'whatjobs' : 'Вручную', title: title || 'Добавлено руками' };
    }
    return { label: channel.length > 24 ? channel.slice(0, 23) + '…' : channel, title };
}

// The tracker is read once per page load, so a row added elsewhere — a chat marked
// «Откликнулся», another device, the agent — only showed after a manual reload. Re-read it
// whenever the page comes back into view, at most every 15 s.
let applicationsLoadedAt = 0;
function refreshApplicationsOnReturn() {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - applicationsLoadedAt < 15000) return;
    loadApplications();
}
document.addEventListener('visibilitychange', refreshApplicationsOnReturn);
window.addEventListener('focus', refreshApplicationsOnReturn);

async function loadApplications() {
    applicationsLoadedAt = Date.now();
    try {
        applications = await api('/applications');
        for (const app of applications) {
            const info = sourceInfo(app);
            app.source_label = info.label;
            app.source_title = info.title;
        }
        renderTracker();
        renderFunnel();
        loadStats();
    } catch (e) { toast(e.message, true); }
}

// ------------------------------------------------------------------ воронка

// Отклик, который месяц лежит без единого движения, на практике уже мёртвый —
// но формально он всё ещё «отклик», и в разбивке по статусам его не видно.
const STALE_DAYS = 30;

// Ступени по возрастанию — воронка читается сверху вниз ровно в этом порядке.
const STAGE_ORDER = ['applied', 'screening', 'tech', 'final', 'offer'];
const STAGE_TITLES = {
    applied: 'Всего откликов', screening: 'Скрининг', tech: 'Техсобес',
    final: 'Финал', offer: 'Оффер',
};

// Чем кончилась ступень для отклика. Пять исходов, и вместе они исчерпывающие:
// прошёл дальше, интервью ещё впереди, ещё ждёт, замолчали, отказали. Цвета проверены
// валидатором палитры на тёмной подложке; в каждой строке рядом с цветом стоит подпись,
// так что цвет нигде не остаётся единственным признаком.
const EXITS = [
    { key: 'next', label: 'прошли дальше', color: '#199e70' },
    { key: 'scheduled', label: 'назначено', color: '#9d7be3' },
    { key: 'live', label: 'ждут ответа', color: '#3987e5' },
    { key: 'ghost', label: `игнор (больше ${STALE_DAYS} дней)`, color: '#8a8a8a' },
    { key: 'rejected', label: 'отказ', color: '#e66767' },
];

// Докуда дошёл отклик. Бэкенд достраивает stage из статуса для строк, которым его никто
// не проставил; тот же откат повторён здесь, чтобы воронка не зависела от версии API.
function stageIndex(app) {
    const stage = app.stage || (app.status === 'offer' ? 'offer'
        : (['interview', 'test_task'].includes(app.status) || app.interview_at) ? 'screening' : '');
    const i = STAGE_ORDER.indexOf(stage);
    return i < 0 ? 0 : i;
}

// Сколько дней отклик не двигался. last_move_at — последнее событие из журнала; дата
// интервью и дата отклика работают тем же сигналом для строк, которых в журнале нет.
function idleDays(app) {
    const stamps = [app.last_move_at, app.interview_at, app.applied_at, app.date]
        .filter(Boolean)
        .map(v => Date.parse(`${String(v).slice(0, 10)}T00:00:00Z`))
        .filter(n => !isNaN(n));
    if (!stamps.length) return 0;
    return Math.floor((Date.now() - Math.max(...stamps)) / 86400000);
}

// Исход той ступени, на которой отклик встал. Для ступеней ниже исход всегда 'next' —
// он туда прошёл, — поэтому спрашивают это только про его собственную ступень.
function exitKey(app) {
    if (app.status === 'rejected') return 'rejected';
    // Пауза в воронке живёт как «игнор» — отдельной корзины у неё нет. Но срок давности
    // к ней не применяем: заморозка не перестаёт быть заморозкой от свежего письма.
    if (app.status === 'on_hold') return 'ghost';
    if (app.status === 'no_response' || app.status === 'withdrawn') return 'ghost';
    if (app.status === 'offer') return 'next';
    if (app.status === 'interview' && interviewAhead(app)) return 'scheduled';
    return idleDays(app) > STALE_DAYS ? 'ghost' : 'live';
}

// Интервью назначено, но ещё не прошло. interview_at — местное «YYYY-MM-DD HH:MM»; с «T»
// вместо пробела его одинаково читают все браузеры, Safari тоже.
function interviewAhead(app) {
    const at = Date.parse(String(app.interview_at || '').trim().replace(' ', 'T'));
    return !isNaN(at) && at > Date.now();
}

// Фильтр таблицы: 'stage:<ступень>' — все, кто до неё дошёл; 'exit:<ступень>:<исход>' —
// те, кто на ней встал с этим исходом.
let funnelFilter = '';

function funnelMatch(app) {
    if (!funnelFilter) return true;
    if (app.status === 'draft') return false;
    const [kind, stage, exit] = funnelFilter.split(':');
    const at = STAGE_ORDER.indexOf(stage);
    if (at < 0) return true;
    const peak = stageIndex(app);
    if (kind === 'stage') return peak >= at;
    return peak === at && exitKey(app) === exit;
}

function renderFunnel() {
    const box = document.getElementById('funnel');
    if (!box) return;
    const sent = applications.filter(a => a.status !== 'draft' && inTrack(a.role));
    const total = sent.length;
    box.classList.toggle('hidden', total === 0);
    if (!total) return;

    // cohort[i] — сколько откликов дошло до ступени i; exits[i] — на чём они там встали.
    const cohort = STAGE_ORDER.map(() => 0);
    const exits = STAGE_ORDER.map(() => ({}));
    for (const app of sent) {
        const peak = stageIndex(app);
        for (let i = 0; i <= peak; i++) cohort[i]++;
        const key = exitKey(app);
        exits[peak][key] = (exits[peak][key] || 0) + 1;
    }

    const rows = STAGE_ORDER.map((stage, i) => {
        const n = cohort[i];
        if (!n) return '';
        const last = i === STAGE_ORDER.length - 1;
        const passed = cohort[i + 1] || 0;
        // Сегменты полосы: сначала те, кто прошёл дальше, потом исходы этой ступени.
        const parts = (!last && passed) ? [{ ...EXITS[0], n: passed }] : [];
        for (const exit of EXITS.slice(1)) {
            if (exits[i][exit.key]) parts.push({ ...exit, n: exits[i][exit.key] });
        }
        if (last) parts.push({ key: 'reached', label: STAGE_TITLES[stage],
                               color: '#c98500', n });

        const segments = parts.map(part => {
            const filter = part.key === 'next' ? `stage:${STAGE_ORDER[i + 1]}`
                : part.key === 'reached' ? `stage:${stage}` : `exit:${stage}:${part.key}`;
            return `<div class="fseg${funnelFilter === filter ? ' on' : ''}"
                         data-filter="${filter}" style="flex-grow:${part.n};background:${part.color}"
                         title="${esc(part.label)}: ${part.n} — ${Math.round(part.n / n * 100)}% от ступени"></div>`;
        }).join('');

        const chips = parts.map(part => {
            const filter = part.key === 'next' ? `stage:${STAGE_ORDER[i + 1]}`
                : part.key === 'reached' ? `stage:${stage}` : `exit:${stage}:${part.key}`;
            const on = funnelFilter === filter;
            return `<button class="fchip${on ? ' on' : ''}" data-filter="${filter}"
                            aria-pressed="${on}">
                        <span class="fdot" style="background:${part.color}"></span>${esc(part.label)}
                        <b>${part.n}</b></button>`;
        }).join('');

        // Конверсия с предыдущей ступени — то, зачем воронку вообще смотрят.
        const conv = i === 0 ? `${Math.round(n / total * 100)}% дошли до отправки`
            : `${Math.round(n / cohort[i - 1] * 100)}% с предыдущей ступени · ` +
              `${Math.round(n / total * 100)}% от всех`;
        // Пол в 3% — чтобы ступень из одного отклика осталась видимой, но не выглядела
        // вровень с теми, где их семь. Выше пола ширина честно линейна.
        const wide = `width:${Math.max(Math.round(n / total * 100), 3)}%`;
        return `
            <div class="fstage">
                <div class="fstage-head">
                    <span class="fstage-name">${esc(STAGE_TITLES[stage])}</span>
                    <span class="fstage-n">${n}</span>
                    <span class="hint">${conv}</span>
                </div>
                <div class="fbar" style="${wide}">${segments}</div>
                <div class="flegend">${chips}</div>
            </div>`;
    }).join('');

    box.innerHTML = `
        <div class="funnel-head">
            <div><span class="funnel-total">${total}</span>
                 ${pluralWord(total, 'отклик отправлен', 'отклика отправлено',
                              'откликов отправлено')}</div>
            <div class="hint">Нажми на сегмент, чтобы отфильтровать таблицу</div>
        </div>
        <div class="fstages">${rows}</div>`;

    box.querySelectorAll('[data-filter]').forEach(el => {
        el.addEventListener('click', () => {
            funnelFilter = funnelFilter === el.dataset.filter ? '' : el.dataset.filter;
            // Два фильтра разом дают пустую таблицу и вопрос «куда всё делось» — ветка
            // воронки и так задаёт статус, поэтому выпадающий список сбрасывается.
            if (funnelFilter) setTrackerStatuses([]);
            renderTracker();
            renderFunnel();
        });
    });
}

function renderTracker() {
    const needle = document.getElementById('tracker-search').value.toLowerCase().trim();
    const statuses = trackerStatuses();
    renderTrackSwitch(document.getElementById('tracker-track'), applications.map(a => a.role));
    let rows = applications.filter(a => {
        if (!inTrack(a.role)) return false;
        if (statuses.size && !statuses.has(a.status)) return false;
        if (!funnelMatch(a)) return false;
        if (!needle) return true;
        return [a.company, a.role, a.sector, a.notes, a.channel, a.source_label]
            .some(v => (v || '').toLowerCase().includes(needle));
    });
    rows.sort((a, b) => {
        let x = a[sortKey], y = b[sortKey];
        if (sortKey === 'fit_rating') { x = x === '' ? -1 : Number(x); y = y === '' ? -1 : Number(y); }
        else { x = String(x || '').toLowerCase(); y = String(y || '').toLowerCase(); }
        return x < y ? -sortDir : x > y ? sortDir : 0;
    });

    document.getElementById('tracker-empty').classList.toggle('hidden', rows.length > 0);
    document.getElementById('tracker-body').innerHTML = rows.map(a => `
        <tr class="row" data-id="${a.id}">
            <td class="nowrap">${esc(a.date)}</td>
            <td class="company">${a.source ? `<a href="${esc(a.source)}" target="_blank" rel="noopener noreferrer">${esc(a.company)}</a>` : esc(a.company)}${contactFlag(a.company, a.contacts, 0)}</td>
            <td>${esc(a.role)}</td>
            <td class="hint source-cell" title="${esc(a.source_title)}">${esc(a.source_label)}</td>
            <td class="nowrap status-cell" data-status-cell="${a.id}">
                <span class="badge ${esc(a.status)}" title="Нажми, чтобы сменить статус">${esc(a.status === 'interview' && INTERVIEW_TYPES[a.stage] ? INTERVIEW_TYPES[a.stage] : (STATUS_LABELS[a.status] || a.status))}</span>
                ${a.interview_at ? `<div class="when">${esc(formatWhen(a.interview_at))}</div>` : ''}
            </td>
            <td class="nowrap hint">${esc(shortDate(a.updated_at))}</td>
            <td class="nowrap"><span class="score ${scoreClass(a.fit_rating)}">${a.fit_rating === '' ? '—' : esc(a.fit_rating)}</span></td>
            <td><div class="note-preview">${esc(a.notes)}</div></td>
            <td class="nowrap"><button class="btn ghost sm" data-edit="${a.id}" title="Изменить" aria-label="Изменить">✏️</button></td>
        </tr>`).join('');

    document.querySelectorAll('[data-edit]').forEach(btn => {
        btn.addEventListener('click', () => openAppModal(
            applications.find(a => a.id === Number(btn.dataset.edit))));
    });
    document.querySelectorAll('[data-status-cell]').forEach(cell => {
        cell.addEventListener('click', event => {
            if (event.target.closest('.status-editor')) return;
            openStatusEditor(cell, Number(cell.dataset.statusCell));
        });
    });
}

function shortDate(value) {
    return (value || '').slice(0, 10);
}

// "YYYY-MM-DD HH:MM" from the DB → "YYYY-MM-DDTHH:MM", which both Date and the
// date/time split below parse.
function toInputDateTime(value) {
    return (value || '').replace(' ', 'T').slice(0, 16);
}

// Interview time is a date input plus a half-hour <select>, not datetime-local: nobody
// books a call for 15:47, and step="1800" is ignored by the iOS wheel picker anyway.
const HALF_HOURS = Array.from({ length: 48 }, (_, i) =>
    `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);

function whenFieldHtml(id, value) {
    const [date, time] = toInputDateTime(value).split('T');
    const current = time || '10:00';
    // An off-grid time already in the DB stays selectable rather than silently moving.
    const times = HALF_HOURS.includes(current) ? HALF_HOURS : [...HALF_HOURS, current].sort();
    return `<div class="when-field" id="${id}">
        <input type="date" class="when-date" value="${esc(date || '')}">
        <select class="when-time">${times.map(t =>
            `<option${t === current ? ' selected' : ''}>${t}</option>`).join('')}</select>
    </div>`;
}

// "YYYY-MM-DD HH:MM" as the DB holds it, or '' when no date is picked.
function readWhen(root) {
    const date = root.querySelector('.when-date').value;
    return date ? `${date} ${root.querySelector('.when-time').value}` : '';
}

function formatWhen(value) {
    const raw = toInputDateTime(value);
    if (!raw) return '';
    const date = new Date(raw);
    if (isNaN(date)) return value;
    return date.toLocaleString('ru-RU',
        { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function openStatusEditor(cell, appId) {
    const app = applications.find(a => a.id === appId);
    if (!app || cell.querySelector('.status-editor')) return;
    const options = Object.entries(STATUS_LABELS)
        .map(([v, l]) => `<option value="${v}"${app.status === v ? ' selected' : ''}>${l}</option>`).join('');
    cell.innerHTML = `
        <div class="status-editor">
            <select class="se-status">${options}</select>
            <div class="se-stage"></div>
            <div class="se-when${app.status === 'interview' ? '' : ' hidden'}">
                <label>Дата и время (необязательно)</label>
                ${whenFieldHtml(`se-at-${appId}`, app.interview_at)}
            </div>
            <div class="se-actions">
                <button class="btn sm se-save">Сохранить</button>
                <button class="btn ghost sm se-cancel">Отмена</button>
            </div>
        </div>`;
    const select = cell.querySelector('.se-status');
    const when = cell.querySelector('.se-when');
    const readStage = mountStageField(cell.querySelector('.se-stage'), select, app.stage);
    select.focus();
    select.addEventListener('change', () => {
        when.classList.toggle('hidden', select.value !== 'interview');
    });
    cell.querySelector('.se-cancel').addEventListener('click', renderTracker);
    cell.querySelector('.se-save').addEventListener('click', async () => {
        const status = select.value;
        const at = readWhen(cell.querySelector('.when-field'));
        // The time only belongs to an interview; switching away clears a stale one.
        const payload = {
            status, stage: readStage(),
            interview_at: status === 'interview' ? at : '',
        };
        try {
            await api(`/applications/${appId}`,
                { method: 'PATCH', body: JSON.stringify(payload) });
            // Перечитываем список целиком: PATCH отдаёт голую строку, без last_move_at
            // из журнала, а воронка по нему решает, живой отклик или уже игнор.
            await loadApplications();
            toast('Статус обновлён');
        } catch (e) { toast(e.message, true); }
    });
}

function scoreClass(value) {
    const n = Number(value);
    if (!value && value !== 0) return 'low';
    return n >= 85 ? 'high' : n >= 70 ? 'mid' : 'low';
}

document.getElementById('tracker-search').addEventListener('input', renderTracker);
// ------------------------------------------------------------------ статусы (мультивыбор)

const statusMenu = document.getElementById('tracker-status');
// «В процессе» — то, по чему ещё что-то может произойти; одной кнопкой, потому что это
// самый частый вопрос к трекеру.
const OPEN_STATUSES = ['applied', 'test_task', 'interview', 'offer', 'on_hold'];

function trackerStatuses() {
    return new Set(Array.from(statusMenu.querySelectorAll('input:checked'), box => box.value));
}

function setTrackerStatuses(values) {
    statusMenu.querySelectorAll('input').forEach(box => { box.checked = values.includes(box.value); });
    renderStatusSummary();
}

function renderStatusSummary() {
    const picked = Array.from(statusMenu.querySelectorAll('input:checked'),
        box => box.parentElement.textContent.trim());
    const summary = statusMenu.querySelector('summary');
    summary.textContent = !picked.length ? 'Все статусы'
        : picked.length <= 2 ? picked.join(', ') : `Статусы: ${picked.length}`;
    summary.title = picked.join(', ');
    statusMenu.classList.toggle('active', picked.length > 0);
}

// Выбор статуса руками отменяет ветку воронки — иначе два фильтра молча режут друг друга.
function onStatusesChanged() {
    funnelFilter = '';
    renderStatusSummary();
    renderTracker();
    renderFunnel();
}

statusMenu.addEventListener('change', onStatusesChanged);
statusMenu.addEventListener('click', event => {
    const action = event.target.closest('[data-multi]')?.dataset.multi;
    if (!action) return;
    setTrackerStatuses(action === 'open' ? OPEN_STATUSES : []);
    onStatusesChanged();
});
// Меню закрывается кликом мимо и Esc, как обычный выпадающий список.
document.addEventListener('click', event => {
    if (statusMenu.open && !statusMenu.contains(event.target)) statusMenu.open = false;
});
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && statusMenu.open) statusMenu.open = false;
});
document.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
        const key = th.dataset.sort;
        sortDir = sortKey === key ? -sortDir : (['date', 'fit_rating', 'updated_at'].includes(key) ? -1 : 1);
        sortKey = key;
        renderTracker();
    });
});

// ------------------------------------------------------------------ mail

const SIGNAL_LABELS = {
    interview: 'Интервью', assessment: 'Тестовое', offer: 'Оффер',
    rejected: 'Отказ', acknowledgement: 'Отклик получен', other: 'Прочее',
};
const CONFIDENCE_LABELS = { high: 'высокая', medium: 'средняя', low: 'низкая' };

async function loadMail() {
    const panel = document.getElementById('mail-panel');
    let items;
    try { items = await api('/mail?state=proposed'); } catch (e) { return; }
    if (!items.length) { panel.classList.add('hidden'); panel.innerHTML = ''; return; }
    panel.classList.remove('hidden');
    panel.innerHTML = `
        <div class="mail-head">📬 ${plural(items.length, 'письмо предлагает', 'письма предлагают', 'писем предлагают')} изменить статус
            <span class="hint">— ничего не записано, пока не подтвердишь</span></div>
        ${items.map(m => `
            <div class="mail-item${m.conflict ? ' conflict' : ''}" data-mail="${m.id}">
                <div class="mail-main">
                    <div class="mail-subject">${esc(m.subject)}</div>
                    <div class="hint">${esc(m.from_name || m.from_addr)} · ${esc(m.sent_at)}</div>
                    ${m.evidence ? `<div class="mail-quote">«${esc(m.evidence)}»</div>` : ''}
                    <div class="mail-target">
                        ${esc(m.app_company)} — ${esc(m.app_role)}:
                        <span class="badge ${esc(m.app_status)}">${esc(STATUS_LABELS[m.app_status] || m.app_status)}</span>
                        →
                        <span class="badge ${esc(signalToStatus(m.signal))}">${esc(STATUS_LABELS[signalToStatus(m.signal)] || m.signal)}</span>
                        ${m.interview_at ? `<span class="when">${esc(formatWhen(m.interview_at))}</span>` : ''}
                        <span class="hint">· уверенность ${esc(CONFIDENCE_LABELS[m.confidence] || m.confidence || '?')}</span>
                    </div>
                    ${m.conflict ? `<div class="mail-warn">⚠ Отклик уже в финальном статусе «${
                        esc(STATUS_LABELS[m.app_status] || m.app_status)}». Письмо, скорее всего, старее — применяй, только если правда откатываешь.</div>` : ''}
                </div>
                <div class="mail-actions">
                    <button class="btn sm" data-mail-apply="${m.id}">Применить</button>
                    <button class="btn ghost sm" data-mail-ignore="${m.id}">Пропустить</button>
                </div>
            </div>`).join('')}`;

    panel.querySelectorAll('[data-mail-apply]').forEach(b => b.addEventListener('click', async () => {
        const item = b.closest('.mail-item');
        if (item.classList.contains('conflict')
            && !confirm('Этот отклик уже в финальном статусе. Точно откатить?')) return;
        try {
            await api(`/mail/${b.dataset.mailApply}/apply`, { method: 'POST' });
            toast('Статус обновлён');
            loadMail(); loadApplications();
loadMail();
        } catch (e) { toast(e.message, true); }
    }));
    panel.querySelectorAll('[data-mail-ignore]').forEach(b => b.addEventListener('click', async () => {
        try {
            await api(`/mail/${b.dataset.mailIgnore}/ignore`, { method: 'POST' });
            loadMail();
        } catch (e) { toast(e.message, true); }
    }));
}

function signalToStatus(signal) {
    return { interview: 'interview', assessment: 'test_task',
             offer: 'offer', rejected: 'rejected' }[signal] || signal;
}

document.getElementById('btn-mail').addEventListener('click', async () => {
    const button = document.getElementById('btn-mail');
    button.disabled = true;
    try {
        await api('/mail/sync', { method: 'POST', body: '{}' });
        toast('Читаю почту…');
        const timer = setInterval(async () => {
            const runs = await api('/runs?limit=3');
            const run = runs.find(r => r.kind === 'mail');
            if (run && run.state !== 'running') {
                clearInterval(timer);
                button.disabled = false;
                loadMail();
                toast(run.state === 'error' ? 'Ошибка — см. лог на вкладке «Поиск»'
                                            : 'Почта проверена', run.state === 'error');
            }
        }, 4000);
    } catch (e) { toast(e.message, true); button.disabled = false; }
});

// ------------------------------------------------------------------ modals

// A modal can be dismissed three ways — its own button, a backdrop click, or the router
// navigating away — so teardown hangs off closeModal rather than off any one handler.
let modalCloseHook = null;

function closeModal() {
    const hook = modalCloseHook;
    modalCloseHook = null;
    document.getElementById('modal-root').innerHTML = '';
    if (hook) hook();
}

function mountModal(html, onClose) {
    modalCloseHook = onClose || null;
    const root = document.getElementById('modal-root');
    root.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
    root.querySelector('.modal-backdrop').addEventListener('click', event => {
        if (event.target === root.querySelector('.modal-backdrop')) closeModal();
    });
}

function openAppModal(app) {
    const a = app || { date: new Date().toISOString().slice(0, 10), status: 'applied', fit_rating: '' };
    const statusOptions = Object.entries(STATUS_LABELS)
        .map(([v, l]) => `<option value="${v}"${a.status === v ? ' selected' : ''}>${l}</option>`).join('');
    mountModal(`
        <h2>${app ? 'Отклик' : 'Новый отклик'}</h2>
        <div class="grid2">
            <div class="field"><label>Дата</label><input id="f-date" type="date" value="${esc(a.date)}"></div>
            <div class="field"><label>Статус</label><select id="f-status">${statusOptions}</select></div>
        </div>
        <div class="grid2">
            <div class="field" id="f-stage"></div>
            <div class="field"><label>Дата и время интервью (необязательно)</label>
                ${whenFieldHtml('f-interview', a.interview_at)}</div>
        </div>
        <div class="grid2">
            <div class="field"><label>Компания *</label><input id="f-company" value="${esc(a.company)}"></div>
            <div class="field"><label>Роль</label><input id="f-role" value="${esc(a.role)}"></div>
        </div>
        <div class="grid2">
            <div class="field"><label>Сектор</label><input id="f-sector" value="${esc(a.sector)}"></div>
            <div class="field"><label>Тип роли</label><input id="f-role_type" value="${esc(a.role_type)}"></div>
        </div>
        <div class="grid2">
            <div class="field"><label>Канал</label><input id="f-channel" value="${esc(a.channel)}"></div>
            <div class="field"><label>Fit (0–100)</label><input id="f-fit" type="number" min="0" max="100" value="${esc(a.fit_rating)}"></div>
        </div>
        <div class="grid2">
            <div class="field"><label>Контакт</label><input id="f-contact" value="${esc(a.contact_person)}"></div>
            <div class="field"><label>Ссылка на вакансию</label><input id="f-source" value="${esc(a.source)}"></div>
        </div>
        <div class="grid2">
            <div class="field"><label>Файл CV</label><input id="f-cv" value="${esc(a.cv_file)}"></div>
            <div class="field"><label>Файл cover letter</label><input id="f-cl" value="${esc(a.cover_letter_file)}"></div>
        </div>
        <div class="field"><label>Заметки</label><textarea id="f-notes" rows="7">${esc(a.notes)}</textarea></div>
        <div class="modal-actions">
            ${app ? '<button class="btn danger" id="m-delete">Удалить</button>' : ''}
            <div class="spacer" style="flex:1"></div>
            <button class="btn ghost" id="m-cancel">Отмена</button>
            <button class="btn" id="m-save">Сохранить</button>
        </div>`);

    const readStage = mountStageField(document.getElementById('f-stage'),
                                      document.getElementById('f-status'), a.stage);
    document.getElementById('m-cancel').addEventListener('click', closeModal);
    document.getElementById('m-save').addEventListener('click', async () => {
        const payload = {
            date: document.getElementById('f-date').value,
            status: document.getElementById('f-status').value,
            stage: readStage(),
            company: document.getElementById('f-company').value.trim(),
            role: document.getElementById('f-role').value.trim(),
            sector: document.getElementById('f-sector').value.trim(),
            role_type: document.getElementById('f-role_type').value.trim(),
            channel: document.getElementById('f-channel').value.trim(),
            fit_rating: document.getElementById('f-fit').value,
            contact_person: document.getElementById('f-contact').value.trim(),
            source: document.getElementById('f-source').value.trim(),
            cv_file: document.getElementById('f-cv').value.trim(),
            cover_letter_file: document.getElementById('f-cl').value.trim(),
            notes: document.getElementById('f-notes').value,
            interview_at: readWhen(document.getElementById('f-interview')),
        };
        if (!payload.company) { toast('Нужна компания', true); return; }
        try {
            if (app) await api(`/applications/${app.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
            else await api('/applications', { method: 'POST', body: JSON.stringify(payload) });
            closeModal();
            loadApplications();
            toast('Сохранено');
        } catch (e) { toast(e.message, true); }
    });
    const del = document.getElementById('m-delete');
    if (del) del.addEventListener('click', async () => {
        if (!confirm(`Удалить отклик «${a.company}»? Это необратимо.`)) return;
        try {
            await api(`/applications/${app.id}`, { method: 'DELETE' });
            closeModal();
            loadApplications();
            toast('Удалено');
        } catch (e) { toast(e.message, true); }
    });
}

document.getElementById('btn-add-app').addEventListener('click', () => openAppModal(null));

document.getElementById('btn-import').addEventListener('click', () => {
    mountModal(`
        <h2>Импорт CSV</h2>
        <p class="hint">Формат трекера ai-job-search. Строки с совпадающей парой компания+роль обновляются, остальные добавляются.</p>
        <div class="field" style="margin-top:12px">
            <textarea id="f-csv" rows="12" placeholder="date,company,sector,role,…"></textarea>
        </div>
        <div class="modal-actions">
            <button class="btn ghost" id="m-cancel">Отмена</button>
            <button class="btn" id="m-import">Импортировать</button>
        </div>`);
    document.getElementById('m-cancel').addEventListener('click', closeModal);
    document.getElementById('m-import').addEventListener('click', async () => {
        try {
            const res = await api('/import', {
                method: 'POST',
                body: JSON.stringify({ csv: document.getElementById('f-csv').value }),
            });
            closeModal();
            loadApplications();
            toast(`Добавлено ${res.created}, обновлено ${res.updated}`);
        } catch (e) { toast(e.message, true); }
    });
});

// ------------------------------------------------------------------ jobs

const STATUS_FILTERS = ['ranked', 'new', 'dismissed'];

async function loadJobs() {
    const filter = document.getElementById('jobs-filter').value;
    const serverStatus = STATUS_FILTERS.includes(filter) ? filter : '';
    try {
        const all = await api('/jobs?limit=1000'
            + (serverStatus ? `&status=${encodeURIComponent(serverStatus)}` : ''));
        // A job whose link is dead is not a candidate any more, so it drops out of the
        // default view — but it is kept, and «Протухшие» shows exactly those.
        if (filter === 'dead') jobs = all.filter(j => j.dead_at);
        else if (filter === 'not_applied') jobs = all.filter(j => j.status !== 'applied' && !j.dead_at);
        else if (!filter) jobs = all.filter(j => j.status !== 'dismissed' && j.status !== 'applied' && !j.dead_at);
        else jobs = all;
        renderJobs();
        revealFocusedJobs();
    } catch (e) { toast(e.message, true); }
}

// One-shot landing for a ?focus= link: open the company group, scroll, highlight.
function revealFocusedJobs() {
    if (!focusJobIds) return;
    const cards = [...focusJobIds]
        .map(id => document.querySelector(`#jobs [data-job-id="${id}"]`)).filter(Boolean);
    focusJobIds = null;
    if (!cards.length) { toast('Этой вакансии уже нет в списке — скрыта или удалена'); return; }
    cards.forEach(card => {
        card.closest('details')?.setAttribute('open', '');
        card.classList.add('focused');
    });
    cards[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// The date a job is filtered and aged by: when it was published, falling back to when we
// first saw it. A board that omits a publication date shouldn't make its jobs undatable.
function effectiveDate(job) {
    return job.published_at || job.first_seen || '';
}

function daysAgo(isoDate) {
    if (!isoDate) return null;
    const then = new Date(isoDate.slice(0, 10) + 'T00:00:00Z');
    if (isNaN(then)) return null;
    const today = new Date();
    const todayUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    return Math.round((todayUTC - then.getTime()) / 86400000);
}

// Russian words like "свежайшая"/"дней назад" eat a whole line on a phone; an icon
// plus a number carries the same meaning in a fifth of the width.
function shortAge(isoDate) {
    const days = daysAgo(isoDate);
    if (days === null) return '';
    if (days <= 0) return 'сегодня';
    if (days === 1) return 'вчера';
    if (days < 31) return `${days} дн`;
    if (days < 365) return `${Math.round(days / 30)} мес`;
    return `${Math.floor(days / 365)} г`;
}

// What to name in the first screening call. Two visually distinct cases on purpose: a
// number derived from a range the employer published is evidence, a number derived from
// the floor is a decision — showing them alike would invite quoting a guess as a fact.
function salaryLine(j) {
    if (!j.salary_ask) return '';
    const grounded = !!(j.salary_stated || '').trim();
    return `<div class="salary-line${grounded ? ' grounded' : ''}">
        <span class="salary-ask" title="Сколько просить">💶 ${esc(j.salary_ask)}</span>
        ${grounded
            ? `<span class="hint">в вакансии: ${esc(j.salary_stated)}</span>`
            : '<span class="hint">вилки в вакансии нет</span>'}
        ${j.salary_basis ? `<span class="hint salary-basis">${esc(j.salary_basis)}</span>` : ''}
    </div>`;
}

// Те же хосты, что AD_REDIRECT_HOSTS на сервере: ссылка — платный клик, а не вакансия.
function isAdRedirect(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        return host === 'whatjobs.com' || host.endsWith('.whatjobs.com');
    } catch (e) { return false; }
}

// Компания в кавычках, название без: агрегаторы переписывают заголовок («… — Remote BI &
// Impact»), и точное совпадение по нему отсекло бы саму страницу работодателя.
function employerSearchUrl(j) {
    const q = `${j.title || ''} "${(j.company || '').replace(/"/g, '')}"`;
    return 'https://www.google.com/search?q=' + encodeURIComponent(q);
}

function jobBody(j, showCompany) {
    const published = shortAge(j.published_at);
    const added = shortAge(j.first_seen);
    const dates = [
        published ? `<span title="Опубликована">🕐 ${esc(published)}</span>` : '',
        added ? `<span title="Добавлена в базу">＋ ${esc(added)}</span>` : '',
    ].filter(Boolean).join(' ');
    const meta = [j.location, j.remote, j.salary, j.portal].filter(Boolean).map(esc).join(' · ');
    return `
        <div class="job-head">
            <div class="title">
                ${j.page_url
                    // url — рекламный редирект whatjobs: пока у объявления есть бюджет, он
                    // ведёт к работодателю, потом — на поиск whatjobs. Текст читаем на
                    // freehire, откликаться ищем у работодателя.
                    ? `<a href="${esc(j.page_url)}" target="_blank" rel="noopener noreferrer"
                          title="Текст вакансии на freehire">${esc(j.title)}</a>`
                    // Без страницы на freehire (объявление там уже закрыто) ссылаться не на
                    // что: whatjobs почти наверняка покажет свой поиск. Ссылки — строкой ниже.
                    : isAdRedirect(j.url) ? `<span>${esc(j.title)}</span>`
                    : /^https?:/i.test(j.url || '')
                    // Вакансия, вставленная текстом без ссылки, живёт под синтетическим
                    // url (`manual:<хеш>`) — ссылкой её показывать некуда.
                    ? `<a href="${esc(j.url)}" target="_blank" rel="noopener noreferrer">${esc(j.title)}</a>`
                    : `<span title="Добавлена текстом, без ссылки">${esc(j.title)} 📋</span>`}${
                    showCompany ? ` — ${esc(j.company)}` : ''}
                <small>${meta}</small>
                ${isAdRedirect(j.url) ? `<small class="job-links">
                    <a href="${esc(employerSearchUrl(j))}" target="_blank" rel="noopener noreferrer"
                       title="Поиск этой вакансии на сайте работодателя — откликаться лучше там">🔎 у работодателя</a>
                    <a href="${esc(j.url)}" target="_blank" rel="noopener noreferrer"
                       title="Рекламная ссылка whatjobs: часто открывает поиск whatjobs, а не вакансию">whatjobs ↗</a>
                </small>` : ''}
                ${j.industry ? `<span class="industry" title="Индустрия компании">${esc(j.industry)}</span>` : ''}
                ${contactFlag(j.company, j.contacts, j.id)}
                ${dates ? `<small class="job-dates">${dates}</small>` : ''}
            </div>
            <div style="text-align:right">
                <div class="score ${scoreClass(j.rank_score)}">${j.rank_score == null ? '—' : esc(j.rank_score)}</div>
                <span class="badge ${esc(j.status)}">${esc(JOB_STATUS_LABELS[j.status] || j.status)}</span>
                ${j.dead_at ? `<span class="badge dead" title="Ссылка не открывается с ${
                    esc((j.dead_at || '').slice(0, 16))} — ${esc(j.dead_reason || '')}"
                    >🪦 протухла</span>` : ''}
            </div>
        </div>
        ${j.rank_verdict ? `<div class="hint" style="margin-top:6px">${esc(j.rank_verdict)}</div>` : ''}
        ${salaryLine(j)}
        ${(j.strengths.length || j.gaps.length) ? `
            <div class="job-bullets">
                ${j.strengths.length ? `<ul class="good">${j.strengths.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
                ${j.gaps.length ? `<ul class="bad">${j.gaps.map(s => `<li>${esc(s)}</li>`).join('')}</ul>` : ''}
            </div>` : ''}
        <div class="job-actions">
            <button class="btn sm" data-apply="${j.id}">✍️ Резюме</button>
            <button class="btn ghost sm" data-promote="${j.id}">→ В трекер</button>
            <button class="btn ghost sm" data-shortlist="${j.id}">В шорт-лист</button>
            <button class="btn ghost sm" data-dismiss="${j.id}">Скрыть</button>
            <button class="btn ghost sm" data-rank1="${j.id}">Переоценить</button>
            <button class="btn ghost sm" data-ban-company="${esc(j.company)}"
                    title="Забанить компанию">🚫</button>
        </div>`;
}

// Big employers post a dozen near-identical analyst roles; one card per posting buries
// everything else. Same company => one collapsible card, ordered by its best score.
function groupByCompany(list) {
    const groups = new Map();
    for (const job of list) {
        const key = (job.company || '—').trim().toLowerCase();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(job);
    }
    const score = j => (j.rank_score == null ? -1 : j.rank_score);
    return Array.from(groups.values())
        .map(items => items.slice().sort((a, b) => score(b) - score(a)))
        .sort((a, b) => score(b[0]) - score(a[0]) || b.length - a.length);
}

// Everything a search should reach, flattened once per job. Cached on the object: the
// list is re-rendered on every keystroke and the descriptions are long.
function jobHaystack(j) {
    if (j._hay === undefined) {
        j._hay = [j.title, j.company, j.location, j.remote, j.salary, j.portal, j.industry,
                  j.rank_verdict, j.description,
                  (j.strengths || []).join(' '), (j.gaps || []).join(' ')]
            .filter(Boolean).join(' ').toLowerCase();
    }
    return j._hay;
}

function renderJobs() {
    const period = Number(document.getElementById('jobs-period').value || 0);
    const minScore = Number(document.getElementById('jobs-min-score').value || 0);
    renderTrackSwitch(document.getElementById('jobs-track'), jobs.map(j => j.title));
    let visible = jobs.filter(j => inTrack(j.title));
    // Space-separated terms are ANDed: "sql remote" means both, which is how you actually
    // narrow 600 postings down to the handful worth reading.
    const terms = (document.getElementById('jobs-search')?.value || '')
        .toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (terms.length) {
        visible = visible.filter(j => terms.every(t => jobHaystack(j).includes(t)));
    }
    if (period) {
        visible = visible.filter(j => {
            const days = daysAgo(effectiveDate(j));
            // Only a job with neither date is undatable; coalesce makes that near-impossible,
            // but keep such a row rather than silently dropping it.
            return days === null || days <= period;
        });
    }
    if (minScore > 0) {
        // An unranked job has no score to compare — keep it, or the score filter would
        // hide exactly the jobs you would want to rank next.
        visible = visible.filter(j => j.rank_score == null || j.rank_score >= minScore);
    }
    const onlyContacts = !!document.getElementById('jobs-contacts')?.checked;
    if (onlyContacts) visible = visible.filter(j => j.contacts > 0);
    // A job the notification pointed at shows up whatever the filters say — a remembered
    // min score or track switch is exactly what made it "impossible to find".
    if (focusJobIds) {
        visible = visible.concat(jobs.filter(j => focusJobIds.has(j.id) && !visible.includes(j)));
    }
    visibleJobs = visible;

    const groups = groupByCompany(visible);
    const openCompanies = new Set(Array.from(document.querySelectorAll('.job-group[open]'))
        .map(el => el.dataset.company));

    const filtering = !!(jobTrack || period || minScore || onlyContacts || terms.length);
    document.getElementById('jobs-empty').classList.toggle('hidden', visible.length > 0);
    // "Запусти скрэпинг" is wrong advice when the база is full and the filter is just narrow.
    document.getElementById('jobs-empty-text').textContent = filtering
        ? 'Ничего не найдено — ослабь фильтры или поиск.'
        : 'Пока пусто. Запусти скрэпинг или добавь вакансию по ссылке.';
    const unranked = visible.filter(j => j.rank_score == null).length;
    const withContacts = jobs.filter(j => j.contacts > 0).length;
    document.getElementById('jobs').innerHTML = (filtering
        ? `<div class="hint" style="margin-bottom:4px">Показано ${visible.length} из ${jobs.length}${
            minScore && unranked ? `, из них ${unranked} без оценки` : ''}</div>`
        : withContacts
            ? `<div class="hint" style="margin-bottom:4px">🤝 Контакт в компании есть у ${withContacts} из ${jobs.length} вакансий</div>`
            : '') + groups.map(items => {
        if (items.length === 1) {
            return `<div class="job" data-job-id="${items[0].id}">${jobBody(items[0], true)}</div>`;
        }
        const key = (items[0].company || '—').trim().toLowerCase();
        const best = items[0];
        const freshDays = items.map(j => daysAgo(effectiveDate(j)))
            .filter(d => d !== null).sort((a, b) => a - b)[0];
        const fresh = freshDays === undefined ? ''
            : shortAge(new Date(Date.now() - freshDays * 86400000).toISOString().slice(0, 10));
        return `
        <details class="job job-group" data-company="${esc(key)}"${openCompanies.has(key) ? ' open' : ''}>
            <summary>
                <span class="group-name">${esc(best.company)}</span>
                ${best.industry ? `<span class="industry" title="Индустрия компании">${esc(best.industry)}</span>` : ''}
                ${contactFlag(best.company, best.contacts, best.id)}
                <span class="hint" title="Вакансий в группе">▤ ${items.length}</span>
                ${fresh ? `<span class="hint" title="Самая свежая">🕐 ${esc(fresh)}</span>` : ''}
                <span class="group-peek hint">${esc(best.title)}</span>
                <span class="score ${scoreClass(best.rank_score)}">${best.rank_score == null ? '—' : esc(best.rank_score)}</span>
                <button class="btn ghost sm group-hide" data-hide-company="${esc(best.company)}"
                        title="Скрыть все вакансии этой компании">✕ все</button>
                <button class="btn ghost sm group-ban" data-ban-company="${esc(best.company)}"
                        title="Забанить: скрыть и не показывать в будущих скрэпингах">🚫</button>
            </summary>
            ${items.map(j => `<div class="job-sub" data-job-id="${j.id}">${jobBody(j, false)}</div>`).join('')}
        </details>`;
    }).join('');

    document.querySelectorAll('[data-promote]').forEach(b => b.addEventListener('click', async () => {
        try {
            await api(`/jobs/${b.dataset.promote}/promote`, { method: 'POST' });
            toast('Добавлено в трекер как черновик');
            loadJobs(); loadApplications();
        } catch (e) { toast(e.message, true); }
    }));
    document.querySelectorAll('[data-hide-company]').forEach(b => {
        b.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            const company = b.dataset.hideCompany;
            if (!confirm(`Скрыть все вакансии «${company}»?`)) return;
            try {
                const res = await api('/jobs/bulk-status', {
                    method: 'POST', body: JSON.stringify({ company, status: 'dismissed' }),
                });
                toast(`Скрыто: ${res.changed}`);
                loadJobs();
            } catch (e) { toast(e.message, true); }
        });
    });
    document.querySelectorAll('[data-ban-company]').forEach(b => {
        b.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            const company = b.dataset.banCompany;
            if (!confirm(`Забанить «${company}»?\n\nВакансии скроются, и компания больше не `
                       + 'будет попадать в скрэпинг. Снять бан можно в «Источниках».')) return;
            try {
                const res = await api('/companies/ban', {
                    method: 'POST', body: JSON.stringify({ company, banned: true }),
                });
                toast(`«${company}» забанена, скрыто вакансий: ${res.hidden}`);
                loadJobs();
            } catch (e) { toast(e.message, true); }
        });
    });
    document.querySelectorAll('[data-apply]').forEach(b => b.addEventListener('click',
        () => openChatForJob(Number(b.dataset.apply))));
    document.querySelectorAll('[data-shortlist]').forEach(b => b.addEventListener('click',
        () => setJobStatus(b.dataset.shortlist, 'shortlisted')));
    document.querySelectorAll('[data-dismiss]').forEach(b => b.addEventListener('click',
        () => setJobStatus(b.dataset.dismiss, 'dismissed')));
    document.querySelectorAll('[data-rank1]').forEach(b => b.addEventListener('click', async () => {
        try {
            await api('/rank', { method: 'POST', body: JSON.stringify({ job_ids: [Number(b.dataset.rank1)] }) });
            toast('Ранжирование запущено');
            loadRuns(); startPolling();
        } catch (e) { toast(e.message, true); }
    }));
}

async function setJobStatus(id, status) {
    try {
        await api(`/jobs/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
        loadJobs();
    } catch (e) { toast(e.message, true); }
}

document.getElementById('jobs-filter').addEventListener('change', loadJobs);
document.getElementById('jobs-period').addEventListener('change', renderJobs);
document.getElementById('jobs-min-score').addEventListener('input', event => {
    document.getElementById('min-score-out').textContent = event.target.value;
    renderJobs();
});
document.getElementById('jobs-contacts')?.addEventListener('change', renderJobs);
// Debounced: a keystroke re-renders every visible card, and there can be hundreds.
document.getElementById('jobs-search')?.addEventListener('input', () => {
    clearTimeout(window._jobsSearchTimer);
    window._jobsSearchTimer = setTimeout(renderJobs, 200);
});

// ------------------------------------------------------------------ contacts

// A referral beats every other channel in this app, so "somebody I know works there"
// is a flag on the card itself rather than something you have to go look up.
function contactFlag(company, count, jobId) {
    if (!count) return '';
    return `<button class="contact-flag" data-contacts="${esc(company)}"${
        jobId ? ` data-contact-job="${jobId}"` : ''
    } title="У тебя ${count} контакт(ов) в этой компании — открыть список">🤝 ${count}</button>`;
}

const TIER_LETTER = t => (t || '?').trim().charAt(0).toUpperCase();
const TIER_TITLES = {
    A: 'Общались недавно', B: 'Общались, но давно',
    C: 'Односторонний контакт', D: 'Никогда не переписывались',
};

function contactRow(c, jobId) {
    const name = `${c.first_name} ${c.last_name}`.trim() || 'Без имени';
    const tier = TIER_LETTER(c.tier);
    const vouch = [
        c.recommended_me ? '<span title="Писал мне рекомендацию">📝</span>' : '',
        c.endorsed_me ? '<span title="Подтверждал мои навыки">⭐</span>' : '',
        c.co_applied ? '<span title="Откликались в одну компанию">🎯</span>' : '',
    ].join('');
    const msgs = (c.msgs_from_them || c.msgs_to_them)
        ? `<span title="Сообщений: от них / от меня">✉ ${c.msgs_from_them}/${c.msgs_to_them}</span>` : '';
    const last = c.last_msg ? `<span title="Последнее сообщение">${esc(c.last_msg.slice(0, 10))}</span>` : '';
    return `
        <div class="contact">
            <div class="contact-main">
                <div class="contact-name">
                    <a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(name)}</a>
                    <span class="tier t${tier}" title="${esc(TIER_TITLES[tier] || c.tier || '')}">${tier}</span>
                    ${vouch}
                </div>
                <div class="hint">${esc(c.position || '—')}${c.bucket ? ` · ${esc(c.bucket)}` : ''}</div>
            </div>
            <div class="contact-side">
                <div class="hint">${[msgs, last].filter(Boolean).join(' · ')}</div>
                <button class="btn ghost sm" data-intro="${c.id}"${jobId ? ` data-intro-job="${jobId}"` : ''}
                        title="Открыть чат и составить черновик обращения">✉️ Черновик</button>
            </div>
        </div>`;
}

async function openContactsModal(company, jobId) {
    mountModal(`<h2>🤝 Контакты в «${esc(company)}»</h2><div class="hint">Загружаю…</div>`);
    let data;
    try {
        data = await api(`/contacts?company=${encodeURIComponent(company)}`);
    } catch (e) { toast(e.message, true); closeModal(); return; }

    const list = data.contacts || [];
    // The split that matters: people who have actually answered you, and everyone else.
    const warm = list.filter(c => TIER_LETTER(c.tier) !== 'D');
    const cold = list.filter(c => TIER_LETTER(c.tier) === 'D');
    const section = (title, items) => items.length
        ? `<div class="contact-section-title">${title} — ${items.length}</div>
           ${items.map(c => contactRow(c, jobId)).join('')}` : '';
    mountModal(`
        <h2>🤝 Контакты в «${esc(company)}»</h2>
        <p class="hint">Имя ведёт на профиль в LinkedIn. «Черновик» откроет чат, который
           напишет обращение по твоему профилю${jobId ? ' и этой вакансии' : ''}.</p>
        <div class="contact-list">
            ${section('Есть история общения', warm)}
            ${section('Холодные контакты', cold)}
            ${list.length ? '' : '<div class="hint">Пусто — возможно, компания называется иначе в экспорте LinkedIn.</div>'}
        </div>
        <div class="modal-actions"><button class="btn ghost" id="m-close">Закрыть</button></div>`);
    document.getElementById('m-close').addEventListener('click', closeModal);
    document.querySelectorAll('[data-intro]').forEach(b => b.addEventListener('click', async () => {
        b.disabled = true;
        try {
            const res = await api(`/contacts/${b.dataset.intro}/intro`, {
                method: 'POST',
                body: JSON.stringify({ job_id: Number(b.dataset.introJob || 0) }),
            });
            openChat(res.chat_id);
        } catch (e) { toast(e.message, true); b.disabled = false; }
    }));
}

// Delegated once: job cards, group headers and tracker rows are all re-rendered often.
document.addEventListener('click', event => {
    const flag = event.target.closest('[data-contacts]');
    if (!flag) return;
    event.preventDefault();
    event.stopPropagation();
    openContactsModal(flag.dataset.contacts, Number(flag.dataset.contactJob || 0));
});

function openContactsImport() {
    mountModal(`
        <h2>🤝 Контакты LinkedIn</h2>
        <p class="hint" id="contacts-stats">Загружаю…</p>
        <p class="hint">Вставь CSV экспорта связей. Нужны колонки <code>First Name, Last Name,
           Company, Position, URL</code>; <code>bucket, tier, last_msg, msgs_from_them,
           msgs_to_them, endorsed_me, recommended_me, co_applied</code> — если есть.
           Человек опознаётся по ссылке на профиль, так что повторный импорт обновляет
           должности, а не плодит дубли.</p>
        <div class="field" style="margin-top:12px">
            <textarea id="f-contacts-csv" rows="10" placeholder="First Name,Last Name,Company,Position,…,URL"></textarea>
        </div>
        <div class="modal-actions">
            <button class="btn ghost" id="m-cancel">Отмена</button>
            <button class="btn" id="m-import-contacts">Импортировать</button>
        </div>`);
    api('/contacts').then(d => {
        const box = document.getElementById('contacts-stats');
        if (box) box.textContent = d.total
            ? `Сейчас в базе ${d.total} контактов в ${d.companies} компаниях.`
            : 'База контактов пуста.';
    }).catch(() => {});
    document.getElementById('m-cancel').addEventListener('click', closeModal);
    document.getElementById('m-import-contacts').addEventListener('click', async () => {
        try {
            const res = await api('/contacts/import', {
                method: 'POST',
                body: JSON.stringify({ csv: document.getElementById('f-contacts-csv').value }),
            });
            closeModal();
            toast(`Добавлено ${res.created}, обновлено ${res.updated}`
                + (res.skipped ? `, пропущено ${res.skipped}` : ''));
            loadApplications(); loadJobs();
        } catch (e) { toast(e.message, true); }
    });
}

document.getElementById('btn-contacts')?.addEventListener('click', openContactsImport);

// ------------------------------------------------------------------ chat

// Ссылки в переписке почти всегда прилетают голым текстом — и от модели, и когда ты сам
// вставляешь адрес вакансии в поле ввода. Работает по уже экранированной строке: `&amp;`
// внутри адреса и в href, и в подписи значит ровно `&`, так что перекодировать нечего.
// Хвостовая пунктуация принадлежит предложению, а не адресу.
const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
// `*` в хвосте — это закрывающая звёздочка markdown вокруг ссылки, а не часть адреса.
const URL_TAIL_RE = /(?:[.,;:!?)\]}*]|&quot;|&#39;)+$/;

// [html ссылки, хвост] или null, если это не адрес. Хвост отдаётся отдельно: в markdown
// он должен остаться снаружи заглушки, иначе закрывающие `**` уедут внутрь неё.
function linkParts(match) {
    const tail = match.match(URL_TAIL_RE);
    const url = tail ? match.slice(0, -tail[0].length) : match;
    if (!/^https?:\/\/[^/\s]/.test(url)) return null;
    return [`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
            tail ? tail[0] : ''];
}

function autolink(escaped) {
    return escaped.replace(URL_RE, match => {
        const parts = linkParts(match);
        return parts ? parts[0] + parts[1] : match;
    });
}

// Minimal markdown renderer. /apply answers in tables and checklists, so raw text is
// close to unreadable. Everything is escaped first, then re-marked up — no raw HTML
// from the model ever reaches the DOM.
function mdToHtml(src) {
    const blocks = [];
    let text = esc(src).replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) => {
        blocks.push(`<pre class="md-code">${code.replace(/\n$/, '')}</pre>`);
        // A distinctive token, not a bare number: "85" appears constantly in these answers.
        return `\n@@CODE${blocks.length - 1}@@\n`;
    });

    // Готовая разметка уходит в заглушки до автолинка: иначе он полез бы внутрь href
    // уже собранного тега и в адреса внутри `code`, где ссылка не нужна.
    const inline = s => {
        const done = [];
        const keep = html => `@@LINK${done.push(html) - 1}@@`;
        // Заглушки бывают вложенными — код внутри подписи ссылки; разворачиваем до конца.
        const restore = html => {
            let prev;
            do { prev = html; html = html.replace(/@@LINK(\d+)@@/g, (m, i) => done[i]); }
            while (html !== prev);
            return html;
        };
        return restore(s
            .replace(/`([^`]+)`/g, (m, code) => keep(`<code>${code}</code>`))
            .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, label, url) =>
                keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`))
            .replace(URL_RE, m => {
                const parts = linkParts(m);
                return parts ? keep(parts[0]) + parts[1] : m;
            })
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>'));
    };

    const lines = text.split('\n');
    const out = [];
    let list = null, table = null;

    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    const closeTable = () => {
        if (!table) return;
        const head = table[0].map(c => `<th>${inline(c)}</th>`).join('');
        const body = table.slice(1).map(r =>
            `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('');
        out.push(`<table class="md-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
        table = null;
    };
    const cells = line => line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());

    for (const line of lines) {
        if (/^\s*\|.*\|\s*$/.test(line)) {
            if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;  // separator row
            closeList();
            (table = table || []).push(cells(line));
            continue;
        }
        closeTable();

        const heading = line.match(/^(#{1,4})\s+(.*)$/);
        if (heading) {
            closeList();
            const level = Math.min(heading[1].length + 2, 6);
            out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
            continue;
        }
        const item = line.match(/^\s*[-*]\s+(.*)$/) || line.match(/^\s*(\d+)\.\s+(.*)$/);
        if (item) {
            const ordered = /^\s*\d+\./.test(line);
            const want = ordered ? 'ol' : 'ul';
            if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
            let body = ordered ? item[2] : item[1];
            body = body.replace(/^\[([ xX])\]\s*/, (m, mark) =>
                mark === ' ' ? '<span class="md-box">☐</span> ' : '<span class="md-box on">☑</span> ');
            out.push(`<li>${inline(body)}</li>`);
            continue;
        }
        closeList();
        if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    closeList();
    closeTable();

    return out.join('').replace(/<p>@@CODE(\d+)@@<\/p>/g, (m, i) => blocks[Number(i)]);
}

let visibleJobs = [];
let lastProgress = {};
let chatId = null;
let chatTimer = null;
let chatJobId = null;
let chatApplied = false;

// `create` is off when the router restores a ?job= from the URL: creating a chat kicks off
// a billed /apply run, and a page reload must never do that on its own. A link to a job
// whose chat has since been deleted therefore just drops back to the plain tab.
async function openChatForJob(jobId, create = true) {
    chatJobId = jobId;
    syncUrl();
    let existing = [];
    try { existing = (await api(`/chats?job_id=${jobId}`)).chats || []; } catch (e) { /* first time */ }
    if (existing.length) { openChat(existing[0].id); return; }
    if (!create) { chatJobId = null; return; }
    mountChatShell('Запускаю /apply…');
    try {
        const chat = await api('/chats', { method: 'POST', body: JSON.stringify({ job_id: jobId }) });
        chatId = chat.id;
        renderChat(chat);
        pollChat();
        loadDock();
    } catch (e) { toast(e.message, true); closeModal(); }
}

// The candidate profile everything else reads (CLAUDE.md, documents/, the master CV) is
// filled in by /setup — an interview in the chat, not tied to any job. A chat already
// holding it is reopened rather than started twice: each start is a billed claude run.
document.getElementById('btn-setup').addEventListener('click', async () => {
    let chats = [];
    try { chats = (await api('/chats')).chats || []; } catch (e) { /* none yet */ }
    const existing = chats.find(c => !c.job_id && c.title === 'Настройка профиля');
    if (existing) { openChat(existing.id); return; }
    if (!confirm('Запустить /setup? Claude расспросит о тебе и заполнит профиль, '
        + 'по которому потом оцениваются вакансии и пишутся резюме.')) return;
    mountChatShell('Запускаю /setup…');
    try {
        const chat = await api('/chats', { method: 'POST',
            body: JSON.stringify({ title: 'Настройка профиля', message: '/setup' }) });
        chatId = chat.id;
        renderChat(chat);
        pollChat();
        loadDock();
    } catch (e) { toast(e.message, true); closeModal(); }
});

// Presence: the server skips the push for a chat reply you are looking at right now. Only
// the visible, focused tab counts — a chat left open in a background tab still gets one.
// Rides along on every chat fetch (the busy chat polls every 4s), and each change of
// focus or visibility is reported straight away so the server never trusts a stale «да».
const TAB_ID = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
let presenceSent = null;   // [chatId, active] last reported

function chatOnScreen() {
    return !!chatId && document.visibilityState === 'visible' && document.hasFocus();
}

function chatPath(id) {
    presenceSent = [id, chatOnScreen()];
    return `/chats/${id}?tab=${TAB_ID}&active=${presenceSent[1] ? 1 : 0}`;
}

function reportPresence(id = chatId, active = chatOnScreen()) {
    if (!id || (presenceSent && presenceSent[0] === id && presenceSent[1] === active)) return;
    presenceSent = [id, active];
    // keepalive: the pagehide report has to outlive the page that sends it.
    fetch(`${API}/chats/${id}/presence`, {
        method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tab: TAB_ID, active }),
    }).catch(() => { /* the server's TTL covers a lost report */ });
}

['visibilitychange', 'focus', 'blur'].forEach(type =>
    (type === 'visibilitychange' ? document : window)
        .addEventListener(type, () => reportPresence()));
window.addEventListener('pagehide', () => reportPresence(chatId, false));

async function openChat(id) {
    // Switching chats from the dock skips teardownChat — let go of the old one here.
    if (chatId && chatId !== id) reportPresence(chatId, false);
    chatId = id;
    mountChatShell('Загружаю…');
    try {
        const chat = await api(chatPath(id));
        renderChat(chat);
        if (chat.busy) pollChat();
        loadDock();
    } catch (e) { toast(e.message, true); closeModal(); }
}

function teardownChat() {
    reportPresence(chatId, false);
    clearInterval(chatTimer);
    chatTimer = null;
    chatId = null;
    chatJobId = null;
    syncUrl();
    loadDock();
}

function mountChatShell(placeholder) {
    mountModal(`
        <div class="chat-head">
            <h2 id="chat-title">Резюме под вакансию</h2>
            <button class="btn ghost sm" id="chat-applied">✅ Откликнулся</button>
            <button class="btn ghost sm" id="chat-restart">Начать заново</button>
            <button class="btn ghost sm" id="chat-close">Закрыть</button>
        </div>
        <div class="chat-files hidden" id="chat-files"></div>
        <div class="chat-log" id="chat-log"><div class="hint">${esc(placeholder)}</div></div>
        <div class="chat-input">
            <textarea id="chat-text" rows="2" placeholder="Ответь или уточни задачу… (Ctrl+Enter — отправить)"></textarea>
            <button class="btn" id="chat-send">Отправить</button>
        </div>
        <div class="hint" id="chat-foot"></div>`, teardownChat);
    document.getElementById('chat-close').addEventListener('click', closeModal);
    document.getElementById('chat-applied').addEventListener('click', toggleChatApplied);
    document.getElementById('chat-restart').addEventListener('click', restartChat);
    document.getElementById('chat-send').addEventListener('click', sendChatMessage);
    document.getElementById('chat-text').addEventListener('keydown', event => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) sendChatMessage();
    });
    // Delegated: the log is re-rendered from scratch on every poll, so per-button
    // listeners would be lost every 4 seconds.
    document.getElementById('chat-log').addEventListener('click', event => {
        const button = event.target.closest('[data-decision]');
        if (!button) return;
        decideAccessRequest(button.closest('.access-req'),
            button.dataset.decision, button.dataset.scope);
    });
}

function renderChat(chat) {
    chatJobId = chat.job_id || chatJobId;
    chatApplied = !!chat.applied;
    document.getElementById('chat-title').textContent = chat.title || 'Чат';
    const appliedBtn = document.getElementById('chat-applied');
    appliedBtn.textContent = chatApplied ? '↩︎ Вернуть в работу' : '✅ Откликнулся';
    appliedBtn.title = chatApplied
        ? 'Вернуть чат в список активных'
        : 'Отметить, что отклик отправлен — чат уйдёт из списка';
    appliedBtn.classList.toggle('done', chatApplied);
    const log = document.getElementById('chat-log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    const asking = (chat.access_requests || []).length > 0;
    log.innerHTML = chat.messages.map(m => {
        if (m.role === 'user') return `<div class="msg user">${autolink(esc(m.content))}</div>`;
        if (m.state === 'pending') {
            if (asking) {
                return `<div class="msg bot pending"><span class="spinner"></span> жду твоего решения по доступу…</div>`;
            }
            return `<div class="msg bot pending"><span class="spinner"></span> думает…
                    <div class="hint">Первый ход /apply долгий: оценка соответствия и черновики — до нескольких минут.</div></div>`;
        }
        const body = m.state === 'error' ? autolink(esc(m.content)) : mdToHtml(m.content);
        return `<div class="msg bot${m.state === 'error' ? ' err' : ''}">${body}</div>`;
    }).join('') || '<div class="hint">Пусто</div>';
    log.insertAdjacentHTML('beforeend',
        (chat.access_requests || []).map(accessRequestCard).join(''));
    // A question on screen is the one thing worth scrolling to unconditionally.
    if (atBottom || asking) log.scrollTop = log.scrollHeight;

    loadChatFiles(chat.company);
    document.getElementById('chat-send').disabled = chat.busy;
    const grants = (chat.granted || []).length;
    document.getElementById('chat-foot').innerHTML =
        `Работает в data/puto_trabajo · компиляция PDF разрешена, shell — нет · ≈$${(chat.cost_usd || 0).toFixed(3)} по API-эквиваленту (тариф Max)`
        + (grants ? ` · <a href="#" id="chat-revoke">снять выданные доступы (${grants})</a>` : '');
    const revoke = document.getElementById('chat-revoke');
    if (revoke) revoke.addEventListener('click', revokeGrants);
}

// The session asks for anything outside its standing permissions — most often a write
// under .claude/, which Claude Code refuses to grant any other way in a headless run.
// Without this card the turn just ends with "I need permission" and no way to give it.
const ACCESS_TOOL_LABELS = {
    Edit: 'Изменить файл', Write: 'Записать файл', MultiEdit: 'Изменить файл',
    NotebookEdit: 'Изменить блокнот', Read: 'Прочитать файл', Glob: 'Поиск файлов',
    Grep: 'Поиск по содержимому',
};

function accessRequestCard(req) {
    const input = req.tool_input || {};
    const target = input.file_path || input.notebook_path || input.path || input.command || '';
    const label = ACCESS_TOOL_LABELS[req.tool_name] || req.tool_name;
    return `
        <div class="access-req" data-req="${req.id}">
            <div class="access-req-head">🔐 Запрос доступа · ${esc(label)}</div>
            ${target ? `<div class="access-req-target">${esc(target)}</div>` : ''}
            <div class="hint">${esc(req.reason || '')}</div>
            <div class="access-req-actions">
                <button class="btn sm" data-decision="allow" data-scope="once">Разрешить</button>
                <button class="btn ghost sm" data-decision="allow" data-scope="chat">Разрешить в этом чате</button>
                <button class="btn ghost sm" data-decision="deny" data-scope="once">Отклонить</button>
            </div>
            <div class="hint">Ответить можно ещё ${req.seconds_left} с — потом сессия продолжит без этого действия.</div>
        </div>`;
}

async function decideAccessRequest(card, decision, scope) {
    const id = card.dataset.req;
    card.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
        await api(`/access-requests/${id}`, {
            method: 'POST', body: JSON.stringify({ decision, scope }),
        });
        card.outerHTML = `<div class="hint">${decision === 'allow' ? 'Доступ выдан' : 'Отклонено'} — продолжаю…</div>`;
        pollChat();
    } catch (e) {
        toast(e.message, true);
        card.querySelectorAll('button').forEach(b => { b.disabled = false; });
    }
}

async function revokeGrants(event) {
    event.preventDefault();
    if (!chatId) return;
    try {
        await api(`/chats/${chatId}/grants`, { method: 'DELETE' });
        renderChat(await api(`/chats/${chatId}`));
        toast('Постоянные доступы этого чата сняты');
    } catch (e) { toast(e.message, true); }
}

// The files /apply produces land in the workspace; surface them next to the conversation
// so a finished draft is one click away instead of a trip to the Документы tab.
async function loadChatFiles(company) {
    const box = document.getElementById('chat-files');
    if (!box) return;
    if (!company) { box.classList.add('hidden'); return; }
    let data;
    try {
        data = await api(`/artifacts?company=${encodeURIComponent(company)}`);
    } catch (e) { return; }

    const groups = [['cv', 'CV', data.cv], ['cover_letters', 'Cover letter', data.cover_letters]];
    const parts = [];
    for (const [folder, label, files] of groups) {
        if (!files || !files.length) continue;
        const links = files.map(f => {
            const kind = f.name.toLowerCase().endsWith('.pdf') ? 'PDF' : 'TeX';
            return `<a class="chat-file ${kind === 'PDF' ? 'pdf' : ''}" target="_blank"
                       rel="noopener noreferrer"
                       title="${esc(f.name)}"
                       href="${API}/artifact?path=${encodeURIComponent(folder + '/' + f.name)}">${kind}</a>`;
        }).join('');
        parts.push(`<span class="chat-file-group"><span class="hint">${label}:</span>${links}</span>`);
    }
    box.innerHTML = parts.join('');
    box.classList.toggle('hidden', !parts.length);
}

function pollChat() {
    clearInterval(chatTimer);
    chatTimer = setInterval(async () => {
        if (!chatId) { clearInterval(chatTimer); chatTimer = null; return; }
        try {
            const chat = await api(chatPath(chatId));
            renderChat(chat);
            if (!chat.busy) {
                clearInterval(chatTimer);
                chatTimer = null;
                loadDocs();
                loadDock();
            }
        } catch (e) { clearInterval(chatTimer); chatTimer = null; }
    }, 4000);
}

// "Резюме" reopens the existing chat for a job, so a turn that went wrong used to be a
// dead end — the resume endpoint replays the same broken session. This drops the chat and
// starts a clean one, which re-runs /apply from scratch.
async function restartChat() {
    if (!chatId) return;
    if (!confirm('Удалить эту переписку и запустить /apply заново?')) return;
    const jobId = chatJobId;
    clearInterval(chatTimer); chatTimer = null;
    try {
        await api(`/chats/${chatId}`, { method: 'DELETE' });
    } catch (e) { toast(e.message, true); return; }
    chatId = null;
    if (jobId) openChatForJob(jobId); else closeModal();
}

async function sendChatMessage() {
    const box = document.getElementById('chat-text');
    const text = box.value.trim();
    if (!text || !chatId) return;
    box.value = '';
    document.getElementById('chat-send').disabled = true;
    try {
        await api(`/chats/${chatId}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
        const chat = await api(chatPath(chatId));
        renderChat(chat);
        pollChat();
        loadDock();
    } catch (e) { toast(e.message, true); box.value = text; }
}

// «Откликнулся» closes the loop on a chat: the draft is done and sent, so it stops
// competing for attention in the dock. Reversible — nothing is deleted.
// The server also moves the chat's job into the tracker as «Отклик»; `tracked` says what
// it did, so the tracker view can refresh without a reload.
function afterTracked(tracked) {
    if (!tracked || !tracked.id) return 'Отмечено как «откликнулся» — чат убран из списка';
    loadApplications();
    if (currentTab === 'search') loadJobs();
    return tracked.status === 'applied'
        ? `«${tracked.company}» ${tracked.created ? 'добавлена в трекер' : 'обновлена в трекере'}`
          + ' со статусом «Отклик»'
        : `«${tracked.company}» уже в трекере — статус ${STATUS_LABELS[tracked.status]
            || tracked.status} не тронут`;
}

async function toggleChatApplied() {
    if (!chatId) return;
    const next = !chatApplied;
    let res;
    try {
        res = await api(`/chats/${chatId}/applied`, {
            method: 'POST', body: JSON.stringify({ applied: next }),
        });
    } catch (e) { toast(e.message, true); return; }
    chatApplied = next;
    loadDock();
    if (next) {
        closeModal();
        toast(afterTracked(res.tracked));
    } else {
        renderChat(await api(`/chats/${chatId}`));
    }
}

// ------------------------------------------------------------------ chat dock

// A /apply run takes minutes and you keep working in the tracker meanwhile, so the list
// of chats lives in a corner of every tab rather than behind a job card you have to find
// again. Chats marked «Откликнулся» are hidden here by default — see list_chats().
let dockTimer = null;
let dockChats = [];

function dockCollapsed() { return localStorage.getItem('pt-dock-collapsed') === '1'; }
function dockShowApplied() { return document.getElementById('dock-applied')?.checked; }

async function loadDock() {
    const dock = document.getElementById('chat-dock');
    if (!dock) return;
    let data;
    try {
        data = await api(`/chats${dockShowApplied() ? '?include_applied=1' : ''}`);
    } catch (e) { return; }
    dockChats = data.chats || [];
    document.getElementById('dock-applied-n').textContent = data.applied_total || 0;
    // Nothing to show and nothing archived: the dock would just be furniture.
    dock.classList.toggle('hidden', !dockChats.length && !data.applied_total);
    dock.classList.toggle('collapsed', dockCollapsed());
    document.getElementById('dock-count').textContent = dockChats.length || '';

    const active = dockChats.filter(c => c.busy || c.waiting).length;
    document.getElementById('dock-list').innerHTML = dockChats.map(c => `
        <div class="dock-item${c.id === chatId ? ' current' : ''}" data-chat="${c.id}">
            <div class="dock-item-main">
                <div class="dock-item-title">${
                    c.waiting ? '<span title="Ждёт твоего решения по доступу">🔐</span> '
                    : c.busy ? '<span class="spinner"></span> ' : ''
                }${esc(c.title || 'Чат')}</div>
                <div class="hint">${esc((c.last || '').replace(/\s+/g, ' ').slice(0, 70))}</div>
            </div>
            <button class="dock-done" data-dock-applied="${c.id}"
                    title="${c.applied ? 'Вернуть в работу' : 'Откликнулся — убрать из списка'}"
            >${c.applied ? '↩︎' : '✓'}</button>
            ${c.job_id ? `<button class="dock-done" data-dock-hide="${c.id}"
                    title="${c.job_status === 'dismissed'
                        ? 'Вернуть вакансию в список' : 'Скрыть вакансию (отклонена)'}"
            >${c.job_status === 'dismissed' ? '👁' : '🙈'}</button>` : ''}
            <button class="dock-done dock-del" data-dock-del="${c.id}"
                    title="Удалить диалог">✕</button>
        </div>`).join('') || '<div class="hint" style="padding:8px">Активных чатов нет</div>';

    // Poll fast only while something is actually running or asking for permission.
    clearInterval(dockTimer);
    dockTimer = setInterval(loadDock, active ? 5000 : 30000);
}

document.getElementById('dock-head')?.addEventListener('click', event => {
    if (event.target.closest('#dock-collapse') || event.target.closest('.dock-title')) {
        localStorage.setItem('pt-dock-collapsed', dockCollapsed() ? '0' : '1');
        document.getElementById('chat-dock').classList.toggle('collapsed', dockCollapsed());
    }
});
document.getElementById('dock-applied')?.addEventListener('change', loadDock);
document.getElementById('dock-list')?.addEventListener('click', async event => {
    const done = event.target.closest('[data-dock-applied]');
    if (done) {
        event.stopPropagation();
        const id = Number(done.dataset.dockApplied);
        const chat = dockChats.find(c => c.id === id);
        try {
            const res = await api(`/chats/${id}/applied`, {
                method: 'POST', body: JSON.stringify({ applied: !chat?.applied }),
            });
            if (id === chatId) chatApplied = !chat?.applied;
            if (!chat?.applied) toast(afterTracked(res.tracked));
            loadDock();
        } catch (e) { toast(e.message, true); }
        return;
    }
    // Вакансия из дока: диалог остаётся, а сама вакансия уходит в «отклонённые» — это тот
    // же статус, что и кнопка отказа в списке, поэтому возврат кладёт её обратно туда,
    // где она была: к оценённым, если оценка есть, иначе в новые.
    const hide = event.target.closest('[data-dock-hide]');
    if (hide) {
        event.stopPropagation();
        const chat = dockChats.find(c => c.id === Number(hide.dataset.dockHide));
        if (!chat?.job_id) return;
        const hidden = chat.job_status === 'dismissed';
        const status = hidden ? (chat.job_ranked ? 'ranked' : 'new') : 'dismissed';
        try {
            await api(`/jobs/${chat.job_id}`, {
                method: 'PATCH', body: JSON.stringify({ status }),
            });
            toast(hidden ? 'Вакансия снова в списке' : 'Вакансия скрыта');
            loadDock(); loadJobs();
        } catch (e) { toast(e.message, true); }
        return;
    }
    const del = event.target.closest('[data-dock-del]');
    if (del) {
        event.stopPropagation();
        const id = Number(del.dataset.dockDel);
        const chat = dockChats.find(c => c.id === id);
        if (!confirm(`Удалить диалог «${chat?.title || 'Чат'}»?\n\n`
                     + 'Переписка пропадёт навсегда, вакансия и отклик останутся.')) return;
        try {
            await api(`/chats/${id}`, { method: 'DELETE' });
            if (id === chatId) {
                clearInterval(chatTimer); chatTimer = null;
                chatId = null;
                closeModal();
            }
            toast('Диалог удалён');
            loadDock();
        } catch (e) { toast(e.message, true); }
        return;
    }
    const item = event.target.closest('[data-chat]');
    if (item) openChat(Number(item.dataset.chat));
});

// ------------------------------------------------------------------ runs

const RUN_LABELS ={ mail: 'Почта', industry: 'Индустрии', scrape: 'Скрэпинг', rank: 'Ранжирование', add_link: 'Добавление по ссылке', discover: 'Полный скан досок', chat: 'Чат', recheck: 'Проверка ссылок' };

async function loadRuns() {
    try {
        const runs = await api('/runs?limit=5');
        // Keep whatever the user has opened open across the 3s poll refresh.
        const open = new Set(Array.from(document.querySelectorAll('.run-log[open]'))
            .map(el => el.dataset.runId));
        document.getElementById('runs').innerHTML = runs.map((r, index) => {
            const log = r.log || 'выполняется…';
            const firstLine = log.split('\n').filter(Boolean).slice(-1)[0] || '';
            // Expand a run that is still going, one the user had open, or the newest error.
            const expand = r.state === 'running' || open.has(String(r.id))
                || (r.state === 'error' && index === 0);
            return `
            <details class="run-log" data-run-id="${r.id}"${expand ? ' open' : ''}>
                <summary>
                    ${r.state === 'running' ? '<span class="spinner"></span>'
                        : r.state === 'error' ? '⚠️' : r.state === 'cancelled' ? '⛔' : '✓'}
                    <strong>${esc(RUN_LABELS[r.kind] || r.kind)}</strong>
                    <span class="hint">${esc(r.started_at)}${r.cost_usd ? ` · ≈$${r.cost_usd.toFixed(3)}` : ''}</span>
                    <span class="run-peek hint">${esc(firstLine.slice(0, 80))}</span>
                    ${r.state === 'running'
                        ? `<button class="btn ghost sm run-cancel" data-cancel="${r.id}">Прервать</button>`
                        : ''}
                </summary>
                ${r.state === 'running' && r.total
                    ? `<div class="run-progress">
                           <div class="run-bar"><div class="run-bar-fill" style="width:${
                               Math.round((r.progress / r.total) * 100)}%"></div></div>
                           <div class="hint">${r.progress} из ${r.total} · ${
                               Math.round((r.progress / r.total) * 100)}%</div>
                       </div>`
                    : ''}
                <pre>${esc(log)}</pre>
            </details>`;
        }).join('');
        document.querySelectorAll('[data-cancel]').forEach(b => {
            b.addEventListener('click', async event => {
                // The button lives inside <summary>; without this the click toggles the log.
                event.preventDefault();
                event.stopPropagation();
                if (!confirm('Прервать выполнение?')) return;
                b.disabled = true;
                try {
                    await api(`/runs/${b.dataset.cancel}/cancel`, { method: 'POST' });
                    toast('Прервано');
                    loadRuns();
                } catch (e) { toast(e.message, true); b.disabled = false; }
            });
        });
        // Scores land batch by batch; reload the list as soon as new ones are committed.
        let advanced = false;
        for (const r of runs) {
            if (r.kind !== 'rank') continue;
            if (lastProgress[r.id] !== undefined && lastProgress[r.id] !== r.progress) advanced = true;
            lastProgress[r.id] = r.progress;
        }
        if (advanced) loadJobs();
        offerManualPaste(runs);
        return runs.some(r => r.state === 'running');
    } catch (e) { return false; }
}

function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
        const stillRunning = await loadRuns();
        if (!stillRunning) {
            clearInterval(pollTimer);
            pollTimer = null;
            loadJobs();
            loadStats();
        }
    }, 3000);
}

document.getElementById('btn-scrape').addEventListener('click', async () => {
    try {
        await api('/scrape', { method: 'POST', body: '{}' });
        toast('Скрэпинг запущен');
        loadRuns(); startPolling();
    } catch (e) { toast(e.message, true); }
});

// The salary recommendation rides along with ranking, so jobs scored before it existed
// have none. This re-runs the same pass over exactly the visible jobs that are missing
// it — a batch of 8 costs roughly the same as ranking 8 fresh postings, hence the count
// in the confirmation rather than a silent spend.
document.getElementById('btn-salary').addEventListener('click', async () => {
    const pending = visibleJobs.filter(j => !j.salary_ask).map(j => j.id);
    if (!pending.length) {
        toast('У всех показанных вакансий рекомендация уже есть', true);
        return;
    }
    if (!confirm(`Оценить зарплату у ${pending.length} вакансий?\n\n`
                 + `Это тот же прогон, что и ранжирование: ≈$${(pending.length * 0.035).toFixed(2)} `
                 + `по эквиваленту API, списывается с лимита подписки. Прервать можно в логе прогона.`)) return;
    try {
        const res = await api('/rank', {
            method: 'POST', body: JSON.stringify({ job_ids: pending }),
        });
        toast(`Считаю зарплату по ${res.count} вакансиям`);
        loadRuns(); startPolling();
    } catch (e) { toast(e.message, true); }
});

// Manual trigger for the same sweep the 06:00 cron runs. Checks every job still in play,
// not just the visible ones: link rot you filtered out of view is still link rot.
document.getElementById('btn-recheck').addEventListener('click', async () => {
    try {
        const res = await api('/recheck', { method: 'POST', body: '{}' });
        toast(`Проверяю ${res.count} ссылок…`);
        loadRuns(); startPolling();
    } catch (e) { toast(e.message, true); }
});

document.getElementById('btn-rank').addEventListener('click', async () => {
    // Rank what the current filters actually show, not the whole table.
    const pending = visibleJobs.filter(j => j.status === 'new').map(j => j.id);
    if (!pending.length) {
        toast('Среди показанных нет вакансий без оценки', true);
        return;
    }
    try {
        const res = await api('/rank', {
            method: 'POST', body: JSON.stringify({ job_ids: pending }),
        });
        toast(`Ранжирую ${res.count} вакансий из показанных`);
        loadRuns(); startPolling();
    } catch (e) { toast(e.message, true); }
});

document.getElementById('btn-add-link').addEventListener('click', async () => {
    const input = document.getElementById('link-url');
    const url = input.value.trim();
    if (!url) { toast('Вставь ссылку', true); return; }
    try {
        await api('/add-link', { method: 'POST', body: JSON.stringify({ url }) });
        input.value = '';
        toast('Разбираю вакансию…');
        loadRuns(); startPolling();
    } catch (e) { toast(e.message, true); }
});
document.getElementById('link-url').addEventListener('keydown', event => {
    if (event.key === 'Enter') document.getElementById('btn-add-link').click();
});

// Не всякую вакансию удаётся вытащить по ссылке: LinkedIn за логином, Workday-тенанты,
// описание, пришедшее письмом. Тогда текст вставляется руками — дальше он идёт тем же
// разбором и оценкой, что и скачанная страница.
function openPasteJobModal(url) {
    mountModal(`
        <h2>Вакансия текстом</h2>
        <p class="hint">Скопируй описание со страницы целиком и вставь сюда: название, компанию,
           требования, обязанности. Оценка считается так же, как по ссылке.</p>
        <div class="field" style="margin-top:12px">
            <label>Ссылка (необязательно)</label>
            <input id="f-paste-url" type="url" value="${esc(url || '')}" placeholder="https://…">
        </div>
        <div class="field">
            <label>Текст вакансии *</label>
            <textarea id="f-paste-text" rows="14"
                      placeholder="Product Data Analyst · Acme · Berlin…"></textarea>
        </div>
        <div class="modal-actions">
            <button class="btn ghost" id="m-cancel">Отмена</button>
            <button class="btn" id="m-paste">Разобрать</button>
        </div>`);
    document.getElementById('m-cancel').addEventListener('click', closeModal);
    document.getElementById('f-paste-text').focus();
    document.getElementById('m-paste').addEventListener('click', async () => {
        const text = document.getElementById('f-paste-text').value.trim();
        if (text.length < 200) { toast('Текста слишком мало — вставь описание целиком', true); return; }
        try {
            await api('/add-link', {
                method: 'POST',
                body: JSON.stringify({
                    url: document.getElementById('f-paste-url').value.trim(), text,
                }),
            });
            closeModal();
            toast('Разбираю вакансию…');
            loadRuns(); startPolling();
        } catch (e) { toast(e.message, true); }
    });
}

document.getElementById('btn-add-text').addEventListener('click', () => {
    openPasteJobModal(document.getElementById('link-url').value.trim());
});

// Когда добавление по ссылке падает, ручная вставка — единственный путь дальше, поэтому
// форма открывается сама, со ссылкой, которая не поддалась. Ошибки, уже лежавшие в логе
// на момент загрузки страницы, не всплывают: это был бы сюрприз при каждом заходе.
let seenAddLinkErrors = null;

function offerManualPaste(runs) {
    const failed = runs.filter(r => r.kind === 'add_link' && r.state === 'error');
    if (seenAddLinkErrors === null) {
        seenAddLinkErrors = new Set(failed.map(r => r.id));
        return;
    }
    const fresh = failed.find(r => !seenAddLinkErrors.has(r.id));
    failed.forEach(r => seenAddLinkErrors.add(r.id));
    // Только на недоступной странице — ошибку разбора ручная вставка не лечит. И ничего
    // уже открытого не перебиваем.
    if (!fresh || !(fresh.log || '').includes('не удалось получить страницу')) return;
    if (document.getElementById('modal-root').children.length) return;
    let params = {};
    try { params = JSON.parse(fresh.params || '{}'); } catch (e) { /* без параметров */ }
    if (params.pasted) return;
    openPasteJobModal(/^https?:/i.test(params.url || '') ? params.url : '');
}

// ------------------------------------------------------------------ sources

const ATS_LABELS = {
    greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby',
    workable: 'Workable', recruitee: 'Recruitee',
};
const FEED_LABELS = {
    remotive: 'Remotive', arbeitnow: 'Arbeitnow', jobicy: 'Jobicy',
    himalayas: 'Himalayas', remoteok: 'RemoteOK', freehire: 'FreeHire', rss: 'RSS',
};

let draftSources = null;

document.getElementById('btn-sources').addEventListener('click', async () => {
    try { draftSources = await api('/sources'); } catch (e) { toast(e.message, true); return; }
    draftSources.keywords = draftSources.keywords || [];
    draftSources.location_terms = draftSources.location_terms || [];
    draftSources.feeds = draftSources.feeds || [];
    draftSources.boards = draftSources.boards || [];
    openSourcesModal();
});

function openSourcesModal() {
    mountModal(`
        <h2>Источники</h2>

        <div class="src-section">
            <div class="src-title">Ключевые слова в названии вакансии</div>
            <div class="hint">Вакансия проходит, если её заголовок содержит одно из них.</div>
            <div class="chips" id="chips-keywords"></div>
            <div class="chip-add">
                <input id="new-keyword" placeholder="например, growth analyst">
                <button class="btn ghost sm" id="add-keyword">Добавить</button>
            </div>
        </div>

        <div class="src-section">
            <div class="src-title">Подходящие локации</div>
            <div class="hint">Вакансия проходит, если её локация или описание содержит одно из них.</div>
            <div class="chips" id="chips-locations"></div>
            <div class="chip-add">
                <input id="new-location" placeholder="например, berlin">
                <button class="btn ghost sm" id="add-location">Добавить</button>
            </div>
        </div>

        <div class="src-section">
            <div class="src-title">Агрегаторы <span class="hint" id="feeds-count"></span></div>
            <div id="list-feeds"></div>
            <details class="src-details">
                <summary>+ Добавить агрегатор</summary>
                <div class="grid2" style="margin-top:10px">
                    <div class="field"><label>Название</label><input id="nf-id" placeholder="my-feed"></div>
                    <div class="field"><label>Тип</label><select id="nf-type">
                        ${Object.entries(FEED_LABELS).map(([v, l]) =>
                            `<option value="${v}">${l}</option>`).join('')}
                    </select></div>
                </div>
                <div class="field"><label>URL</label><input id="nf-url" placeholder="https://…"></div>
                <button class="btn sm" id="add-feed">Добавить</button>
            </details>
        </div>

        <div class="src-section">
            <div class="src-title">Доски компаний <span class="hint" id="boards-count"></span></div>
            <div class="hint">Вставь ссылку на любую вакансию компании — ATS и код доски определятся сами.</div>
            <div class="chip-add" style="margin-bottom:8px">
                <input id="board-url" placeholder="https://job-boards.greenhouse.io/company/jobs/123">
                <button class="btn ghost sm" id="detect-board">Определить</button>
            </div>
            <div class="chip-add" style="margin-bottom:8px">
                <input id="probe-names" placeholder="Или названия компаний через запятую: preply, feverup, wallapop">
                <button class="btn ghost sm" id="probe-board">Найти</button>
            </div>
            <div class="chip-add" style="margin-bottom:8px">
                <button class="btn ghost sm" id="discover-boards">🌍 Просканировать все публичные доски (~16 000, ≈10 мин)</button>
            </div>
            <div class="chip-add" style="margin-bottom:10px">
                <button class="btn ghost sm" id="harvest-boards">🔎 Найти доски на Hacker News</button>
                <select id="harvest-months" style="flex:0 0 auto">
                    <option value="6">за 6 месяцев</option>
                    <option value="12" selected>за 12 месяцев</option>
                    <option value="24">за 24 месяца</option>
                </select>
            </div>
            <div id="harvest-result"></div>
            <div id="list-boards"></div>
        </div>

        <div class="src-section">
            <div class="src-title">Забаненные компании <span class="hint" id="banned-count"></span></div>
            <div class="hint">Их вакансии не попадают в скрэпинг.</div>
            <div id="banned-list"></div>
        </div>

        <div class="modal-actions">
            <button class="btn ghost" id="m-test-all">Проверить все</button>
            <div style="flex:1"></div>
            <button class="btn ghost" id="m-cancel">Отмена</button>
            <button class="btn" id="m-save-sources">Сохранить</button>
        </div>`);

    renderChips();
    renderFeeds();
    renderBoards();
    renderBanned();

    const addKeyword = () => addChip('keywords', 'new-keyword');
    const addLocation = () => addChip('location_terms', 'new-location');
    document.getElementById('add-keyword').addEventListener('click', addKeyword);
    document.getElementById('add-location').addEventListener('click', addLocation);
    document.getElementById('new-keyword').addEventListener('keydown',
        e => { if (e.key === 'Enter') addKeyword(); });
    document.getElementById('new-location').addEventListener('keydown',
        e => { if (e.key === 'Enter') addLocation(); });

    document.getElementById('add-feed').addEventListener('click', () => {
        const id = document.getElementById('nf-id').value.trim();
        const url = document.getElementById('nf-url').value.trim();
        if (!id || !url) { toast('Нужны название и URL', true); return; }
        draftSources.feeds.push({ id, type: document.getElementById('nf-type').value, url, enabled: true });
        document.getElementById('nf-id').value = '';
        document.getElementById('nf-url').value = '';
        renderFeeds();
    });

    document.getElementById('detect-board').addEventListener('click', async () => {
        const input = document.getElementById('board-url');
        const url = input.value.trim();
        if (!url) { toast('Вставь ссылку', true); return; }
        try {
            const board = await api('/sources/detect', { method: 'POST', body: JSON.stringify({ url }) });
            const exists = draftSources.boards.some(
                b => b.ats === board.ats && b.token === board.token);
            if (exists) { toast('Такая доска уже есть'); return; }
            draftSources.boards.push(board);
            input.value = '';
            renderBoards();
            toast(`Добавлено: ${ATS_LABELS[board.ats]} / ${board.token}`);
        } catch (e) { toast(e.message, true); }
    });
    document.getElementById('board-url').addEventListener('keydown',
        e => { if (e.key === 'Enter') document.getElementById('detect-board').click(); });

    document.getElementById('harvest-boards').addEventListener('click', harvestBoards);
    document.getElementById('discover-boards').addEventListener('click', discoverBoards);
    document.getElementById('probe-board').addEventListener('click', probeCompanies);
    showLastDiscovery();
    document.getElementById('probe-names').addEventListener('keydown',
        e => { if (e.key === 'Enter') probeCompanies(); });
    document.getElementById('m-cancel').addEventListener('click', closeModal);
    document.getElementById('m-test-all').addEventListener('click', testAllSources);
    document.getElementById('m-save-sources').addEventListener('click', async () => {
        try {
            await api('/sources', { method: 'PUT', body: JSON.stringify(draftSources) });
            closeModal();
            toast('Источники сохранены');
        } catch (e) { toast(e.message, true); }
    });
}

async function renderBanned() {
    const box = document.getElementById('banned-list');
    if (!box) return;
    let items = [];
    try { items = await api('/companies?banned=1'); } catch (e) { return; }
    document.getElementById('banned-count').textContent = `(${items.length})`;
    box.innerHTML = items.length
        ? items.map(c => `
            <div class="src-row">
                <div class="src-info">
                    <div class="src-name">${esc(c.name)}</div>
                    ${c.industry ? `<div class="src-sub">${esc(c.industry)}</div>` : ''}
                </div>
                <button class="btn ghost sm" data-unban="${esc(c.name)}">Снять бан</button>
            </div>`).join('')
        : '<div class="hint">пусто</div>';
    box.querySelectorAll('[data-unban]').forEach(b => {
        b.addEventListener('click', async () => {
            try {
                await api('/companies/ban', {
                    method: 'POST',
                    body: JSON.stringify({ company: b.dataset.unban, banned: false }),
                });
                toast('Бан снят. Вакансии вернутся при следующем скрэпинге.');
                renderBanned();
            } catch (e) { toast(e.message, true); }
        });
    });
}

function addChip(key, inputId) {
    const input = document.getElementById(inputId);
    const value = input.value.trim().toLowerCase();
    if (!value) return;
    if (draftSources[key].includes(value)) { toast('Уже есть'); return; }
    draftSources[key].push(value);
    input.value = '';
    renderChips();
}

function renderChips() {
    const build = (key, containerId) => {
        document.getElementById(containerId).innerHTML = draftSources[key].map((value, index) =>
            `<span class="chip">${esc(value)}<button data-chip="${key}" data-index="${index}">×</button></span>`
        ).join('') || '<span class="hint">пусто — фильтр не применяется</span>';
    };
    build('keywords', 'chips-keywords');
    build('location_terms', 'chips-locations');
    document.querySelectorAll('[data-chip]').forEach(btn => btn.addEventListener('click', () => {
        draftSources[btn.dataset.chip].splice(Number(btn.dataset.index), 1);
        renderChips();
    }));
}

function sourceRow(kind, index, title, subtitle, entry) {
    return `
        <div class="src-row" data-kind="${kind}" data-index="${index}">
            <label class="toggle">
                <input type="checkbox" data-toggle="${kind}:${index}" ${entry.enabled !== false ? 'checked' : ''}>
                <span></span>
            </label>
            <div class="src-info">
                <div class="src-name">${esc(title)}</div>
                <div class="src-sub">${esc(subtitle)}</div>
                <div class="src-result hint" data-result="${kind}:${index}"></div>
            </div>
            <button class="btn ghost sm" data-test="${kind}:${index}">Проверить</button>
            <button class="btn ghost sm" data-remove="${kind}:${index}">×</button>
        </div>`;
}

function renderFeeds() {
    const feeds = draftSources.feeds;
    document.getElementById('feeds-count').textContent = `(${feeds.length})`;
    document.getElementById('list-feeds').innerHTML = feeds.map((f, i) =>
        sourceRow('feeds', i, f.id || '(без названия)',
                  `${FEED_LABELS[f.type] || f.type} · ${f.url}`, f)
    ).join('') || '<div class="hint">пусто</div>';
    bindSourceRows();
}

function renderBoards() {
    const boards = draftSources.boards;
    document.getElementById('boards-count').textContent = `(${boards.length})`;
    document.getElementById('list-boards').innerHTML = boards.map((b, i) =>
        sourceRow('boards', i, b.token,
                  `${ATS_LABELS[b.ats] || b.ats}${b.region === 'eu' ? ' · EU' : ''}`, b)
    ).join('') || '<div class="hint">пусто</div>';
    bindSourceRows();
}

function bindSourceRows() {
    document.querySelectorAll('[data-toggle]').forEach(input => {
        input.onchange = () => {
            const [kind, index] = input.dataset.toggle.split(':');
            draftSources[kind][Number(index)].enabled = input.checked;
        };
    });
    document.querySelectorAll('[data-remove]').forEach(btn => {
        btn.onclick = () => {
            const [kind, index] = btn.dataset.remove.split(':');
            draftSources[kind].splice(Number(index), 1);
            kind === 'feeds' ? renderFeeds() : renderBoards();
        };
    });
    document.querySelectorAll('[data-test]').forEach(btn => {
        btn.onclick = () => testSource(btn.dataset.test, btn);
    });
}

async function testSource(ref, button) {
    const [kind, index] = ref.split(':');
    const entry = draftSources[kind][Number(index)];
    const output = document.querySelector(`[data-result="${ref}"]`);
    if (button) { button.disabled = true; button.textContent = '…'; }
    if (output) { output.textContent = 'проверяю…'; output.className = 'src-result hint'; }
    let ok = false;
    try {
        const res = await api('/sources/test', {
            method: 'POST',
            body: JSON.stringify({ kind: kind === 'boards' ? 'board' : 'feed', entry }),
        });
        if (!output) return res.ok;
        if (!res.ok) {
            output.textContent = (res.throttled ? '⏳ ' : '✗ ') + res.error;
            output.className = 'src-result ' + (res.throttled ? 'warn' : 'bad');
        } else if (res.total === 0) {
            output.textContent = '⚠ источник ответил, но вакансий не вернул';
            output.className = 'src-result warn';
        } else {
            ok = true;
            output.textContent = `✓ ${res.total} вакансий, подходит ${res.matched}`
                + (res.samples.length ? ` — ${res.samples.join('; ')}` : '');
            output.className = 'src-result good';
        }
    } catch (e) {
        if (output) {
            output.textContent = '✗ ' + e.message;
            output.className = 'src-result bad';
        }
    } finally {
        if (button) { button.disabled = false; button.textContent = 'Проверить'; }
    }
    return ok;
}

async function discoverBoards() {
    const button = document.getElementById('discover-boards');
    button.disabled = true;
    try {
        await api('/sources/discover', { method: 'POST', body: '{}' });
        closeModal();
        toast('Скан запущен — прогресс на вкладке «Поиск», займёт ~10 минут');
        loadRuns();
        startPolling();
    } catch (e) {
        toast(e.message, true);
        button.disabled = false;
    }
}

async function showLastDiscovery() {
    const output = document.getElementById('harvest-result');
    let runs;
    try { runs = await api('/runs?limit=20'); } catch (e) { return; }
    const run = runs.find(r => r.kind === 'discover');
    if (!run) return;
    if (run.state === 'running') {
        output.innerHTML = `<div class="hint"><span class="spinner"></span> Скан идёт: ${esc(run.log || '…')}</div>`;
        return;
    }
    if (run.state !== 'done' || !run.result) return;
    let candidates;
    try { candidates = (JSON.parse(run.result).candidates || []); } catch (e) { return; }
    const existing = new Set(draftSources.boards.map(b => `${b.ats}:${(b.token || '').toLowerCase()}`));
    const fresh = candidates.filter(b => !existing.has(`${b.ats}:${(b.token || '').toLowerCase()}`));
    if (!fresh.length) return;
    renderCandidates(output, fresh, `Последний полный скан (${esc(run.started_at)}) нашёл ${
        plural(fresh.length, 'доску', 'доски', 'досок')} с подходящими вакансиями`,
        b => `${ATS_LABELS[b.ats] || b.ats} · ${b.matched} из ${b.total} — ${b.sample || ''}`,
        b => b.matched >= 2);
}

// Shared picker for every board-discovery path (HN harvest, name probe, full sweep).
function renderCandidates(output, items, heading, describe, preselect) {
    output.innerHTML = `
        <div class="harvest-box">
            <div class="harvest-head">${heading}</div>
            <div class="harvest-actions">
                <button class="btn ghost sm" id="c-all">Отметить все</button>
                <button class="btn ghost sm" id="c-none">Снять все</button>
                <div style="flex:1"></div>
                <button class="btn sm" id="c-add">Добавить выбранные</button>
            </div>
            <div class="harvest-list">
                ${items.map((b, i) => `
                    <label class="harvest-item">
                        <input type="checkbox" data-cand="${i}" ${preselect(b) ? 'checked' : ''}>
                        <span class="harvest-name">${esc(b.token)}</span>
                        <span class="hint">${esc(describe(b))}</span>
                    </label>`).join('')}
            </div>
        </div>`;
    const boxes = () => Array.from(output.querySelectorAll('[data-cand]'));
    const updateCount = () => {
        document.getElementById('c-add').textContent =
            `Добавить выбранные (${boxes().filter(b => b.checked).length})`;
    };
    boxes().forEach(b => b.addEventListener('change', updateCount));
    document.getElementById('c-all').addEventListener('click', () => {
        boxes().forEach(b => { b.checked = true; }); updateCount();
    });
    document.getElementById('c-none').addEventListener('click', () => {
        boxes().forEach(b => { b.checked = false; }); updateCount();
    });
    document.getElementById('c-add').addEventListener('click', () => {
        const picked = boxes().filter(b => b.checked).map(b => items[Number(b.dataset.cand)]);
        picked.forEach(b => {
            const board = { ats: b.ats, token: b.token, enabled: true };
            if (b.region) board.region = b.region;
            draftSources.boards.push(board);
        });
        output.innerHTML = `<div class="src-result good">✓ Добавлено ${picked.length}. Не забудь «Сохранить».</div>`;
        renderBoards();
    });
    updateCount();
}

async function probeCompanies() {
    const input = document.getElementById('probe-names');
    const button = document.getElementById('probe-board');
    const output = document.getElementById('harvest-result');
    const names = input.value.trim();
    if (!names) { toast('Введи название компании', true); return; }
    button.disabled = true;
    button.textContent = '…';
    output.innerHTML = '<div class="hint">Пробую название на всех ATS…</div>';
    let data;
    try {
        data = await api('/sources/probe', { method: 'POST', body: JSON.stringify({ names }) });
    } catch (e) {
        output.innerHTML = `<div class="src-result bad">✗ ${esc(e.message)}</div>`;
        return;
    } finally {
        button.disabled = false;
        button.textContent = 'Найти';
    }
    const fresh = data.found.filter(b => !b.known);
    if (!fresh.length) {
        output.innerHTML = `<div class="hint">Досок не найдено${
            data.found.length ? ` (${data.found.length} уже в списке)` : ''
        }. Попробуй вставить ссылку на вакансию — так надёжнее.</div>`;
        return;
    }
    input.value = '';
    renderCandidates(output, fresh,
        `Найдено ${plural(fresh.length, 'доска', 'доски', 'досок')}`,
        b => `${ATS_LABELS[b.ats] || b.ats}${b.region === 'eu' ? ' · EU' : ''} · ${b.total} вакансий, подходит ${b.matched}`,
        () => true);
}

async function harvestBoards() {
    const button = document.getElementById('harvest-boards');
    const output = document.getElementById('harvest-result');
    const months = document.getElementById('harvest-months').value;
    button.disabled = true;
    button.textContent = 'Ищу…';
    output.innerHTML = '<div class="hint">Читаю треды «Ask HN: Who is hiring?»…</div>';
    let data;
    try {
        data = await api('/sources/harvest', { method: 'POST', body: JSON.stringify({ months: Number(months) }) });
    } catch (e) {
        output.innerHTML = `<div class="src-result bad">✗ ${esc(e.message)}</div>`;
        return;
    } finally {
        button.disabled = false;
        button.textContent = '🔎 Найти доски на Hacker News';
    }
    if (!data.candidates.length) {
        output.innerHTML = `<div class="hint">Найдено ${data.found}, все уже есть в списке.</div>`;
        return;
    }
    // Boards seen in 2+ monthly threads belong to companies that hire continuously —
    // pre-check those, leave one-off mentions for the user to opt into.
    renderCandidates(output, data.candidates,
        `Найдено ${data.found} досок за ${data.months} мес., новых ${data.candidates.length}`
        + (data.known ? ` (${data.known} уже есть)` : '')
        + '<div class="hint">Отмечены те, что встречаются минимум в 2 тредах — такие компании нанимают постоянно.</div>',
        b => `${ATS_LABELS[b.ats] || b.ats}${b.region === 'eu' ? ' · EU' : ''} · ${plural(b.mentions, 'тред', 'треда', 'тредов')}`,
        b => b.mentions >= 2);
}

async function testAllSources() {
    const button = document.getElementById('m-test-all');
    button.disabled = true;
    button.textContent = 'Проверяю…';
    const refs = [
        ...draftSources.feeds.map((_, i) => `feeds:${i}`),
        ...draftSources.boards.map((_, i) => `boards:${i}`),
    ];
    // Sequential on purpose: a burst of parallel probes reads as scraping to some portals.
    for (const ref of refs) await testSource(ref, null);
    button.disabled = false;
    button.textContent = 'Проверить все';
}

// ------------------------------------------------------------------ docs

// `/apply` and `/interview` each research the company from scratch, so applying and later
// prepping for the same job paid for the same research twice. They now share a cache under
// company_research/. It is worth showing because it is the difference between the next run
// costing a research pass or not — but only that: the entries are not clickable, since the
// cached JSON is working state, not a document the user wants to open.
function researchSection(items) {
    const rows = items || [];
    if (!rows.length) return '';
    const cells = rows.map(r => {
        const when = r.fetched_date || 'дата не указана';
        const age = r.age_days === null || r.age_days === undefined
            ? '' : `, ${r.age_days} дн. назад`;
        const mark = r.stale ? '⌛' : '✓';
        const title = r.stale
            ? `Устарело или без даты — следующий /apply или /interview исследует компанию заново`
            : `Свежее — следующий /apply или /interview переиспользует этот результат`;
        return `<span class="doc-file research-item" title="${esc(title)}">${mark} ${esc(r.company)}
                <span class="hint">(${esc(when)}${age})</span></span>`;
    });
    return `<div class="section-title">Исследование компаний (${rows.length})</div>
            <div class="hint" style="line-height:2">${cells.join(' · ')}</div>`;
}

let shares = {};
let docSets = [];
let docResearch = [];

// Сортировка помнится между заходами; поиск и фильтры — нет, это разовый вопрос.
const docsSort = document.getElementById('docs-sort');
docsSort.value = localStorage.getItem('pt-docs-sort') || 'new';
if (!docsSort.value) docsSort.value = 'new';

// Статусы трекера, сведённые к вопросам, которые задают про папку с документами.
const DOC_STATUS_FILTERS = {
    active: s => ['applied', 'test_task', 'interview', 'offer'].includes(s),
    interview: s => s === 'interview' || s === 'offer',
    rejected: s => s === 'rejected',
    closed: s => ['rejected', 'no_response', 'withdrawn'].includes(s),
    none: s => !s,
};
const DOC_KIT_FILTERS = {
    full: d => Object.keys(d.cv).length && Object.keys(d.cover).length,
    no_cover: d => !Object.keys(d.cover).length,
    // .tex без .pdf — /apply не докомпилировал или компиляция упала: такой комплект не
    // отправить, и это стоит видеть отдельно.
    no_pdf: d => (d.cv.tex && !d.cv.pdf) || (d.cover.tex && !d.cover.pdf),
    archive: d => !!d.archive,
};

async function loadDocs() {
    try {
        const [data, shareList] = await Promise.all([
            api('/artifacts'),
            api('/shares').catch(() => []),
        ]);
        shares = Object.fromEntries(shareList.map(s => [s.path, s]));
        docSets = data.sets || [];
        docResearch = data.research || [];
        renderDocs();
    } catch (e) { toast(e.message, true); }
}

function docFileLink(path, label, title, shareable = true) {
    const share = shares[path];
    const link = `<a href="${API}/artifact?path=${encodeURIComponent(path)}"
                target="_blank" rel="noopener noreferrer" title="${esc(title || path)}">${esc(label)}</a>`;
    // Исходник .tex наружу не отправляют — кнопка «поделиться» у него была бы шумом.
    if (!shareable) return `<span class="doc-file">${link}</span>`;
    // 🔗 while private, 🌍 once a public link exists — the icon is the state,
    // because "did I already share this one?" is the question you actually have.
    return `<span class="doc-file">${link}
            <button class="btn ghost sm doc-share${share ? ' shared' : ''}" data-share="${esc(path)}"
                    title="${share
                        ? `Публичная ссылка активна · открытий: ${share.hits}. Клик — скопировать, Alt+клик — отозвать`
                        : 'Создать публичную ссылку на этот файл'}"
            >${share ? '🌍' : '🔗'}</button></span>`;
}

// CV и письмо: PDF — главное, .tex — исходник рядом мелко. Без PDF честно говорим, что
// собирать нечего отправлять.
function docSlot(label, files) {
    if (!files.pdf && !files.tex) return `<span class="doc-slot missing">${label}: нет</span>`;
    return `<span class="doc-slot"><span class="doc-kind">${label}</span>
        ${files.pdf ? docFileLink(files.pdf, 'PDF') : '<span class="hint" title="Есть только исходник — PDF не собран">PDF не собран</span>'}
        ${files.tex ? docFileLink(files.tex, '.tex', 'Исходник LaTeX', false) : ''}</span>`;
}

function docCard(d) {
    const created = new Date(d.created);
    const updated = new Date(d.updated);
    const day = date => date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
    const touched = d.updated.slice(0, 10) !== d.created.slice(0, 10)
        ? ` · обновлено ${day(updated)}` : '';
    const archive = d.archive ? `
        <details class="doc-archive">
            <summary>🗂 Архив заявки · ${plural(d.archive.files.length, 'файл', 'файла', 'файлов')}</summary>
            <div class="doc-archive-files">${d.archive.files.map(f =>
                docFileLink(`documents/applications/${d.archive.name}/${f}`, f)).join('')}</div>
        </details>` : '';
    return `
        <div class="doc-card">
            <div class="doc-head">
                <div class="doc-title">
                    <span class="doc-company">${esc(d.company || '—')}</span>
                    <span class="doc-role">${d.role ? esc(d.role) : '<span class="hint">должность не указана</span>'}</span>
                </div>
                ${d.status ? `<span class="badge ${esc(d.status)}">${esc(STATUS_LABELS[d.status] || d.status)}</span>`
                    : '<span class="badge doc-untracked" title="Этой заявки нет в трекере">не в трекере</span>'}
                <span class="hint doc-date" title="Создано ${esc(created.toLocaleString('ru-RU'))}${esc(touched)}">${esc(day(created))}</span>
            </div>
            <div class="doc-files">${docSlot('CV', d.cv)}${docSlot('Письмо', d.cover)}</div>
            ${archive}
        </div>`;
}

function renderDocs() {
    const box = document.getElementById('docs-content');
    renderTrackSwitch(document.getElementById('docs-track'), docSets.map(d => d.role));
    const terms = document.getElementById('docs-search').value.toLowerCase().trim()
        .split(/\s+/).filter(Boolean);
    const status = document.getElementById('docs-status').value;
    const kit = document.getElementById('docs-kit').value;
    const sort = docsSort.value;

    let list = docSets.filter(d => inTrack(d.role)
        && (!status || DOC_STATUS_FILTERS[status](d.status))
        && (!kit || DOC_KIT_FILTERS[kit](d))
        && terms.every(t => `${d.company} ${d.role} ${d.key}`.toLowerCase().includes(t)));

    const byText = field => (a, b) => (a[field] || '￿').localeCompare(b[field] || '￿', 'ru')
        || b.created.localeCompare(a.created);
    list = list.slice().sort({
        new: (a, b) => b.created.localeCompare(a.created),
        old: (a, b) => a.created.localeCompare(b.created),
        company: byText('company'),
        role: byText('role'),
    }[sort]);

    // Разделители: по месяцам для дат, по первой букве для алфавита — длинный список
    // читается кусками, а не сплошной стеной.
    const groupOf = d => sort === 'company' || sort === 'role'
        ? ((d[sort] || '').trim()[0] || '—').toUpperCase()
        : new Date(d.created).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
    let current = null;
    const rows = list.map(d => {
        const group = groupOf(d);
        const head = group !== current
            ? `<div class="doc-group">${esc(group.charAt(0).toUpperCase() + group.slice(1))}</div>` : '';
        current = group;
        return head + docCard(d);
    }).join('');

    const filtering = terms.length || status || kit || jobTrack;
    box.innerHTML = `
        <div class="hint" style="margin:4px 0 8px">${filtering
            ? `Показано ${list.length} из ${plural(docSets.length, 'заявки', 'заявок', 'заявок')}`
            : plural(docSets.length, 'заявка', 'заявки', 'заявок')}</div>
        ${rows || `<div class="empty">${docSets.length ? 'Ничего не найдено — ослабь фильтры.'
            : 'Пока пусто. Документы появятся после первого /apply.'}</div>`}
        ${researchSection(docResearch)}`;
}

document.getElementById('docs-search').addEventListener('input', renderDocs);
['docs-status', 'docs-kit'].forEach(id =>
    document.getElementById(id).addEventListener('change', renderDocs));
docsSort.addEventListener('change', () => {
    localStorage.setItem('pt-docs-sort', docsSort.value);
    renderDocs();
});

// Clipboard write needs a user gesture and a secure context; if either is missing the
// link still has to reach the user, hence the prompt() fallback rather than a failure.
async function copyLink(url) {
    try {
        await navigator.clipboard.writeText(url);
        toast('Ссылка скопирована');
    } catch (e) {
        prompt('Скопируй ссылку:', url);
    }
}

document.getElementById('docs-content')?.addEventListener('click', async event => {
    const button = event.target.closest('[data-share]');
    if (!button) return;
    const path = button.dataset.share;
    const existing = shares[path];
    if (existing && event.altKey) {
        if (!confirm(`Отозвать публичную ссылку?\n\n${existing.label || path}\n`
                     + `Открытий: ${existing.hits}. Ссылка перестанет работать у всех, `
                     + `кому ты её отправлял.`)) return;
        try {
            await api(`/shares/${existing.token}`, { method: 'DELETE' });
            toast('Ссылка отозвана');
            loadDocs();
        } catch (e) { toast(e.message, true); }
        return;
    }
    try {
        const res = await api('/shares', {
            method: 'POST', body: JSON.stringify({ path }),
        });
        await copyLink(res.url);
        if (res.created) loadDocs();
    } catch (e) { toast(e.message, true); }
});

// ------------------------------------------------------------------ push notifications

// Browser notifications for the every-3-hours автопрогон: it fires only when the
// unattended ranking scored something at or above the server's threshold, so this stays
// rare enough to be worth a buzz. Manual runs never notify — you are already looking.

const PUSH_SW_URL = '/sw.js';
const INSTALL_HINT = 'На iPhone уведомления приходят только установленному приложению: '
    + '«Поделиться» → «На экран „Домой“», открой его оттуда и нажми эту кнопку.';
let pushOn = false;
let pushCfg = { available: false, public_key: '', min_score: 60 };
// Set when the browser can't do push at all but the user can fix that by installing the
// app. Empty otherwise — an unfixable browser gets no button rather than a dead one.
let pushBlocked = '';

// iPadOS reports itself as a Mac, hence the touch probe.
function isIOS() {
    return /iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent)
        || (navigator.userAgent.includes('Mac') && 'ontouchend' in document);
}

function isInstalled() {
    return window.navigator.standalone === true
        || window.matchMedia('(display-mode: standalone)').matches;
}

// The VAPID public key travels as base64url; subscribe() wants raw bytes.
function b64ToBytes(value) {
    const padded = (value + '='.repeat((4 - value.length % 4) % 4))
        .replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(padded);
    return Uint8Array.from(raw, c => c.charCodeAt(0));
}

function renderPush() {
    const btn = document.getElementById('btn-push');
    if (pushBlocked) {
        btn.textContent = '🔔 Уведомления';
        btn.title = pushBlocked;
        return;
    }
    btn.classList.toggle('ghost', !pushOn);
    btn.textContent = pushOn ? '🔔 Уведомления вкл.' : '🔔 Уведомления';
    btn.title = pushOn
        ? `Уведомлю, когда автопрогон найдёт вакансию с оценкой ${pushCfg.min_score}+, `
          + 'когда в чате придёт ответ или запрос доступа. '
          + 'Нажми, чтобы отключить на этом устройстве.'
        : `Уведомлять в браузере о вакансиях с оценкой ${pushCfg.min_score}+, `
          + 'об ответах и запросах доступа в чатах';
}

function sendSubscription(sub) {
    const json = sub.toJSON();
    return api('/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
    });
}

async function initPush() {
    try { pushCfg = await api('/push'); } catch (e) { return; }
    if (!pushCfg.available) return;   // no VAPID keys on the server — button stays hidden
    if (!('serviceWorker' in navigator) || !('PushManager' in window)
        || !('Notification' in window)) {
        // Safari in an iOS tab has none of these; the same Safari in an installed web app
        // has all three. So this is an instruction, not a dead end — show the button and
        // let the tap explain. Any other browser without push just gets nothing.
        if (isIOS() && !isInstalled()) {
            pushBlocked = INSTALL_HINT;
            document.getElementById('btn-push').classList.remove('hidden');
            renderPush();
        }
        return;
    }
    let reg;
    try { reg = await navigator.serviceWorker.register(PUSH_SW_URL); } catch (e) { return; }
    const sub = await reg.pushManager.getSubscription();
    if (sub && Notification.permission === 'granted') {
        // Re-send on every load. It is an upsert, and it heals the one state the browser
        // can't see: the server having pruned this endpoint after a push service said 410.
        try { await sendSubscription(sub); pushOn = true; } catch (e) { pushOn = false; }
    }
    document.getElementById('btn-push').classList.remove('hidden');
    renderPush();
}

async function enablePush() {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
        toast(permission === 'denied'
            ? 'Уведомления запрещены для сайта — разреши их в настройках браузера'
            : 'Разрешение на уведомления не выдано', true);
        return;
    }
    const reg = await navigator.serviceWorker.register(PUSH_SW_URL);
    await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: b64ToBytes(pushCfg.public_key),
    });
    await sendSubscription(sub);
    pushOn = true;
    renderPush();
    // Send one straight away: otherwise "включено" is a claim, and a push chain that is
    // quietly broken would only show up as silence three hours later.
    try {
        await api('/push/test', { method: 'POST', body: '{}' });
    } catch (e) {
        toast('Подписка сохранена, но тестовое уведомление не дошло: ' + e.message, true);
    }
}

async function disablePush() {
    // No argument: match the registration controlling this page, which is the one
    // initPush created — getRegistration() takes a client URL, not a script URL.
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub) {
        await sub.unsubscribe();
        // If this call fails the row survives, but harmlessly: the next push gets a 410
        // from the service and prunes it.
        try {
            await api('/push/unsubscribe', {
                method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }),
            });
        } catch (e) { /* pruned on next send */ }
    }
    pushOn = false;
    renderPush();
    toast('Уведомления отключены');
}

document.getElementById('btn-push').addEventListener('click', async event => {
    const btn = event.currentTarget;
    if (pushBlocked) { toast(pushBlocked, true); return; }
    btn.disabled = true;
    try {
        await (pushOn ? disablePush() : enablePush());
    } catch (e) {
        toast(e.message || 'Не удалось настроить уведомления', true);
    } finally {
        btn.disabled = false;
    }
});

// ------------------------------------------------------------------ init

(async function init() {
    if (!await checkAuth()) return;
    await loadTracks();
    loadApplications();
    loadMail();
    loadDock();
    applyUrlState();
    initPush();
})();
