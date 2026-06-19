const Picker = {
    itemH: 50, els: { h: document.getElementById('wheel-hour'), m: document.getElementById('wheel-min'), ap: document.getElementById('wheel-ampm') },
    isAdjusting: false,
    init() {
        this.els.h.innerHTML = this.genOpts(1, 12, false, 3);
        this.els.m.innerHTML = this.genOpts(0, 59, true, 3);
        this.els.ap.innerHTML = `<div class="wheel-spacer"></div><div class="wheel-item" data-val="AM">AM</div><div class="wheel-item" data-val="PM">PM</div><div class="wheel-spacer"></div>`;

        Object.values(this.els).forEach(el => {
            el.addEventListener('scroll', () => {
                this.handleInfiniteScroll(el);
                Array.from(el.children).forEach(c => {
                    if (c.classList.contains('wheel-item')) {
                        const box = c.getBoundingClientRect(); const parent = el.getBoundingClientRect();
                        const offset = Math.abs((box.top + box.height / 2) - (parent.top + parent.height / 2));
                        if (offset < 25) c.style.color = '#fff'; else c.style.color = '#555';
                    }
                });
            });
            el.addEventListener('click', (e) => {
                if (e.target.classList.contains('wheel-item')) {
                    const targetScroll = e.target.offsetTop - el.offsetHeight / 2 + e.target.offsetHeight / 2;
                    el.scrollTo({ top: targetScroll, behavior: 'smooth' });
                }
            });
            this.addDrag(el);
        });
    },
    genOpts(min, max, pad = false, multiplier = 1) {
        let s = `<div class="wheel-spacer"></div>`;
        for (let k = 0; k < multiplier; k++) {
            for (let i = min; i <= max; i++) {
                const v = pad ? i.toString().padStart(2, '0') : i;
                s += `<div class="wheel-item" data-val="${v}">${v}</div>`;
            }
        }
        return s + `<div class="wheel-spacer"></div>`;
    },
    handleInfiniteScroll(el) {
        if (this.isAdjusting) return;
        const count = el.querySelectorAll('.wheel-item').length;
        if (count < 10) return;
        const singleSetCount = count / 3;
        const singleSetH = singleSetCount * this.itemH;
        const currentScroll = el.scrollTop;
        if (currentScroll < singleSetH / 2) {
            this.isAdjusting = true;
            el.scrollTop = currentScroll + singleSetH;
            this.isAdjusting = false;
        }
        else if (currentScroll > singleSetH * 2.5) {
            this.isAdjusting = true;
            el.scrollTop = currentScroll - singleSetH;
            this.isAdjusting = false;
        }
    },
    addDrag(el) {
        let isDown = false; let startY; let scrollTop;
        el.addEventListener('mousedown', (e) => { isDown = true; startY = e.pageY - el.offsetTop; scrollTop = el.scrollTop; el.classList.add('grabbing'); });
        el.addEventListener('mouseleave', () => { isDown = false; el.classList.remove('grabbing'); });
        el.addEventListener('mouseup', () => { isDown = false; el.classList.remove('grabbing'); });
        el.addEventListener('mousemove', (e) => {
            if (!isDown) return; e.preventDefault();
            const y = e.pageY - el.offsetTop; const walk = (y - startY) * 2;
            el.scrollTop = scrollTop - walk;
        });
    },
    set(h, m, apStr) {
        const setToMiddle = (val, min, count) => {
            const idx = val - min;
            return (count * this.itemH) + (idx * this.itemH);
        };
        this.els.h.scrollTop = setToMiddle(h, 1, 12);
        this.els.m.scrollTop = setToMiddle(m, 0, 60);
        this.els.ap.scrollTop = (apStr === 'AM' ? 0 : 1) * this.itemH;
        Object.values(this.els).forEach(el => el.dispatchEvent(new Event('scroll')));
    },
    get() {
        const getVal = (el) => {
            let closest = null, minD = Infinity;
            Array.from(el.children).forEach(c => {
                if (c.classList.contains('wheel-item')) {
                    const box = c.getBoundingClientRect(); const parent = el.getBoundingClientRect();
                    const d = Math.abs((box.top + box.height / 2) - (parent.top + parent.height / 2));
                    if (d < minD) { minD = d; closest = c; }
                }
            });
            return closest ? closest.dataset.val : null;
        };
        return { h: getVal(this.els.h), m: getVal(this.els.m), ap: getVal(this.els.ap) };
    }
};

const Alarm = {
    alarms: [], listEl: document.getElementById('alarm-list-container'), infoEl: document.getElementById('next-alarm-info'), editId: null,
    snoozeInterval: null, tempSoundId: null, tempSoundName: null,
    init() {
        const saved = localStorage.getItem('timer_alarms');
        if (saved) { try { this.alarms = JSON.parse(saved); this.render(); } catch (e) { } }
        Picker.init();
        setInterval(() => this.check(), 1000);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                this.check();
            }
        });
        document.querySelectorAll('.day-btn').forEach(btn => {
            btn.addEventListener('click', (e) => { e.target.classList.toggle('selected'); });
        });
    },
    persist() { localStorage.setItem('timer_alarms', JSON.stringify(this.alarms)); },
    check() {
        const now = new Date();
        const nowStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        const currentDay = now.getDay();
        const dateStr = now.getDate();
        let changed = false;
        this.alarms.forEach(a => {
            const triggerKey = `${dateStr}_${nowStr}`;
            if (a.active && a.time24 === nowStr && a.lastTriggeredKey !== triggerKey) {
                a.lastTriggeredKey = triggerKey;
                const days = a.days || [];
                if (days.length === 0 || days.includes(currentDay)) {
                    if (days.length === 0) { a.active = false; changed = true; }
                    Background.startPersistence();
                    AudioMgr.startAlarm(a.soundId);
                }
            }
        });
        if (changed) { this.render(); this.persist(); }
        this.updateInfo();
    },
    snooze() {
        AudioMgr.stopSound();
        const btnSnooze = document.getElementById('btn-snooze');
        const cdDisplay = document.getElementById('ring-countdown');
        btnSnooze.style.display = 'none';
        cdDisplay.style.display = 'block';
        const targetTime = Date.now() + (9 * 60 * 1000);
        const update = () => {
            const diff = targetTime - Date.now();
            if (diff <= 0) {
                clearInterval(this.snoozeInterval);
                AudioMgr.startAlarm();
                btnSnooze.style.display = 'block';
                cdDisplay.style.display = 'none';
            } else {
                const m = Math.floor(diff / 60000).toString().padStart(2, '0');
                const s = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');
                cdDisplay.textContent = `${m}:${s}`;
            }
        };
        update();
        if (this.snoozeInterval) clearInterval(this.snoozeInterval);
        this.snoozeInterval = setInterval(update, 1000);
    },
    stopRing() {
        AudioMgr.stopAlarm();
        if (this.snoozeInterval) clearInterval(this.snoozeInterval);
        document.getElementById('btn-snooze').style.display = 'block';
        document.getElementById('ring-countdown').style.display = 'none';
    },
    openPicker(id = null) {
        this.editId = id; let h, m, ap, days = [], soundName = "Default Beep", soundId = null;
        const delBtn = document.getElementById('modal-delete-btn');
        if (id) {
            const a = this.alarms.find(x => x.id === id);
            if (a) {
                const [H, M] = a.time24.split(':').map(Number); ap = H >= 12 ? 'PM' : 'AM'; h = H % 12 || 12; m = M;
                days = a.days || [];
                if (a.soundName) soundName = a.soundName;
                if (a.soundId) soundId = a.soundId;
                delBtn.style.display = 'block';
            }
        } else {
            const now = new Date(Date.now() + 60000); const H = now.getHours(); ap = H >= 12 ? 'PM' : 'AM'; h = H % 12 || 12; m = now.getMinutes();
            delBtn.style.display = 'none';
        }
        this.tempSoundId = soundId;
        this.tempSoundName = soundName;
        document.getElementById('current-sound-name').textContent = soundName;
        document.getElementById('sound-input').value = "";
        setTimeout(() => Picker.set(h, m, ap), 50);
        document.querySelectorAll('.day-btn').forEach(btn => {
            const d = parseInt(btn.dataset.day);
            if (days.includes(d)) btn.classList.add('selected'); else btn.classList.remove('selected');
        });
        document.getElementById('modal-time-picker').style.display = 'flex';
    },
    handleFileSelect(e) {
        const file = e.target.files[0];
        if (!file) return;
        const id = 'sound_' + Date.now();
        this.tempSoundId = id;
        this.tempSoundName = file.name;
        document.getElementById('current-sound-name').textContent = file.name;
        MusicStore.save(id, file);
    },
    closePicker() { document.getElementById('modal-time-picker').style.display = 'none'; this.editId = null; },
    save() {
        const val = Picker.get();
        if (val.h && val.m && val.ap) {
            let H = parseInt(val.h);
            if (val.ap === 'PM' && H !== 12) H += 12; if (val.ap === 'AM' && H === 12) H = 0;
            const time24 = `${H.toString().padStart(2, '0')}:${val.m.toString().padStart(2, '0')}`;
            const days = [];
            document.querySelectorAll('.day-btn.selected').forEach(btn => days.push(parseInt(btn.dataset.day)));
            days.sort((a, b) => a - b);
            if (this.editId) {
                const a = this.alarms.find(x => x.id === this.editId);
                if (a) { a.time24 = time24; a.days = days; a.soundId = this.tempSoundId; a.soundName = this.tempSoundName; }
            } else {
                this.alarms.push({ id: Date.now(), time24: time24, active: true, days: days, soundId: this.tempSoundId, soundName: this.tempSoundName });
            }
            this.render(); this.persist();
        }
        this.closePicker();
    },
    delete() { if (this.editId) { this.alarms = this.alarms.filter(a => a.id !== this.editId); this.render(); this.persist(); this.closePicker(); } },
    toggle(id, e) { e.stopPropagation(); const a = this.alarms.find(x => x.id === id); if (a) { a.active = !a.active; this.render(); this.persist(); } },
    render() {
        this.alarms.sort((a, b) => a.time24.localeCompare(b.time24));
        this.listEl.innerHTML = this.alarms.map(a => {
            const [H, M] = a.time24.split(':').map(Number);
            const ap = H >= 12 ? 'PM' : 'AM'; const h = H % 12 || 12; const m = M.toString().padStart(2, '0');
            let dayStr = "";
            if (a.days && a.days.length > 0) {
                if (a.days.length === 7) dayStr = "Daily";
                else if (a.days.length === 2 && a.days.includes(0) && a.days.includes(6)) dayStr = "Weekends";
                else if (a.days.length === 5 && !a.days.includes(0) && !a.days.includes(6)) dayStr = "Weekdays";
                else { const map = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; dayStr = a.days.map(d => map[d]).join(', '); }
            }
            const soundIcon = a.soundId ? `<span style="font-size:0.8rem; margin-left:6px; color:var(--accent);">♫</span>` : '';
            return `<div class="alarm-item" onclick="Alarm.openPicker(${a.id})">
                <div class="alarm-time" style="color:${a.active ? 'var(--text-primary)' : 'var(--text-secondary)'}">
                    <span>${h}:${m}<span class="alarm-note">${ap}</span>${soundIcon}</span>
                    ${dayStr ? `<span class="alarm-days">${dayStr}</span>` : ''}
                </div>
                <div class="toggle-switch ${a.active ? 'on' : ''}" onclick="Alarm.toggle(${a.id}, event)"></div>
            </div>`;
        }).join('');
        this.updateInfo();
    },
    updateInfo() {
        const active = this.alarms.filter(a => a.active);
        if (active.length === 0) { this.infoEl.textContent = ""; return; }
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();
        const nowDay = now.getDay();
        let minMinutes = Infinity;
        active.forEach(a => {
            const [h, m] = a.time24.split(':').map(Number);
            const alarmMin = h * 60 + m;
            const days = (a.days && a.days.length > 0) ? a.days : null;
            if (!days) {
                let diff = alarmMin - nowMin; if (diff <= 0) diff += 1440; if (diff < minMinutes) minMinutes = diff;
            } else {
                days.forEach(d => {
                    let dayOffset = (d - nowDay + 7) % 7; let diff;
                    if (dayOffset === 0) { diff = alarmMin - nowMin; if (diff <= 0) diff += 10080; } else { diff = (dayOffset * 1440) + (alarmMin - nowMin); }
                    if (diff < minMinutes) minMinutes = diff;
                });
            }
        });
        if (minMinutes === Infinity) { this.infoEl.textContent = ""; return; }
        const daysLeft = Math.floor(minMinutes / 1440);
        const hrsLeft = Math.floor((minMinutes % 1440) / 60);
        const minsLeft = minMinutes % 60;
        let txt = "Alarm in ";
        if (daysLeft > 0) txt += `${daysLeft}d `;
        if (hrsLeft > 0) txt += `${hrsLeft}h `;
        txt += `${minsLeft}m`;
        this.infoEl.textContent = txt;
    }
};
