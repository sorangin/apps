const Picker = {
    itemH: 50,
    els: { h: document.getElementById('wheel-hour'), m: document.getElementById('wheel-min'), ap: document.getElementById('wheel-ampm') },
    isAdjusting: false,

    init() {
        this.els.h.innerHTML = this.genOpts(1, 12, false, 3);
        this.els.m.innerHTML = this.genOpts(0, 59, true, 3);
        this.els.ap.innerHTML = `<div class="wheel-spacer"></div><div class="wheel-item" data-val="AM">AM</div><div class="wheel-item" data-val="PM">PM</div><div class="wheel-spacer"></div>`;

        Object.entries(this.els).forEach(([type, el]) => {
            el.addEventListener('scroll', () => {
                this.handleInfiniteScroll(el);
                this.updateHighlight(el);
            });
            el.addEventListener('click', (e) => {
                const target = e.target.closest('.wheel-item');
                if (target) {
                    const targetScroll = target.offsetTop - el.offsetHeight / 2 + target.offsetHeight / 2;
                    el.scrollTo({ top: targetScroll, behavior: 'smooth' });
                }
            });
            this.addDrag(el);
            this.addWheel(el);
        });
    },

    genOpts(min, max, pad = false, multiplier = 1) {
        let s = `<div class="wheel-spacer"></div>`;
        for (let k = 0; k < multiplier; k++) {
            for (let i = min; i <= max; i++) {
                const v = pad ? i.toString().padStart(2, '0') : i.toString();
                s += `<div class="wheel-item" data-val="${v}">${v}</div>`;
            }
        }
        return s + `<div class="wheel-spacer"></div>`;
    },

    updateHighlight(el) {
        const parent = el.getBoundingClientRect();
        if (parent.height === 0) return;
        const parentCenter = parent.top + parent.height / 2;
        Array.from(el.children).forEach(c => {
            if (c.classList.contains('wheel-item')) {
                const box = c.getBoundingClientRect();
                const itemCenter = box.top + box.height / 2;
                const offset = Math.abs(itemCenter - parentCenter);
                if (offset < 25) {
                    c.style.color = '#ffffff';
                    c.style.opacity = '1';
                } else {
                    c.style.color = '#888888';
                    c.style.opacity = Math.max(0.25, 1 - (offset / 100)).toFixed(2);
                }
            }
        });
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
        } else if (currentScroll > singleSetH * 2.2) {
            this.isAdjusting = true;
            el.scrollTop = currentScroll - singleSetH;
            this.isAdjusting = false;
        }
    },

    addWheel(el) {
        el.addEventListener('wheel', (e) => {
            e.preventDefault();
            const direction = Math.sign(e.deltaY);
            if (direction !== 0) {
                el.scrollBy({ top: direction * this.itemH, behavior: 'smooth' });
            }
        }, { passive: false });
    },

    addDrag(el) {
        let isDown = false;
        let startY = 0;
        let startScrollTop = 0;

        const onMouseDown = (e) => {
            if (e.button !== 0) return;
            isDown = true;
            startY = e.clientY;
            startScrollTop = el.scrollTop;
            el.classList.add('grabbing');
            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
        };

        const onMouseMove = (e) => {
            if (!isDown) return;
            e.preventDefault();
            const deltaY = e.clientY - startY;
            el.scrollTop = startScrollTop - deltaY;
        };

        const onMouseUp = () => {
            if (!isDown) return;
            isDown = false;
            el.classList.remove('grabbing');
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
            const snapIndex = Math.round(el.scrollTop / this.itemH);
            el.scrollTo({ top: snapIndex * this.itemH, behavior: 'smooth' });
        };

        el.addEventListener('mousedown', onMouseDown);
    },

    set(h, m, apStr) {
        const hourNum = parseInt(h) || 12;
        const minNum = parseInt(m) || 0;
        const isPm = (apStr === 'PM');

        const hourScroll = (12 + (hourNum - 1)) * this.itemH;
        const minScroll = (60 + minNum) * this.itemH;
        const apScroll = (isPm ? 1 : 0) * this.itemH;

        this.els.h.scrollTop = hourScroll;
        this.els.m.scrollTop = minScroll;
        this.els.ap.scrollTop = apScroll;

        requestAnimationFrame(() => {
            this.updateHighlight(this.els.h);
            this.updateHighlight(this.els.m);
            this.updateHighlight(this.els.ap);
        });
    },

    get() {
        const getValFromScroll = (el, type) => {
            let closest = null, minD = Infinity;
            const parent = el.getBoundingClientRect();
            if (parent.height > 0) {
                const parentCenter = parent.top + parent.height / 2;
                Array.from(el.children).forEach(c => {
                    if (c.classList.contains('wheel-item')) {
                        const box = c.getBoundingClientRect();
                        const itemCenter = box.top + box.height / 2;
                        const d = Math.abs(itemCenter - parentCenter);
                        if (d < minD) { minD = d; closest = c; }
                    }
                });
            }
            if (closest && closest.dataset.val !== undefined) {
                return closest.dataset.val;
            }
            const idx = Math.round(el.scrollTop / this.itemH);
            if (type === 'h') {
                return (((idx % 12) + 1)).toString();
            } else if (type === 'm') {
                return ((idx % 60)).toString().padStart(2, '0');
            } else if (type === 'ap') {
                return idx <= 0 ? 'AM' : 'PM';
            }
            return null;
        };
        return {
            h: getValFromScroll(this.els.h, 'h'),
            m: getValFromScroll(this.els.m, 'm'),
            ap: getValFromScroll(this.els.ap, 'ap')
        };
    }
};

const Alarm = {
    alarms: [],
    listEl: document.getElementById('alarm-list-container'),
    infoEl: document.getElementById('next-alarm-info'),
    editId: null,
    snoozeInterval: null,
    snoozeTargetTime: null,
    tempSoundId: null,
    tempSoundName: null,
    lastCheck: Date.now(),

    init() {
        const saved = localStorage.getItem('timer_alarms');
        if (saved) {
            try { this.alarms = JSON.parse(saved); this.render(); } catch (e) { }
        }
        Picker.init();
        this.lastCheck = Date.now();
        setInterval(() => this.check(), 1000);

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                this.check();
                if (this.snoozeTargetTime && Date.now() >= this.snoozeTargetTime) {
                    clearInterval(this.snoozeInterval);
                    this.snoozeTargetTime = null;
                    AudioMgr.startAlarm();
                    const btnSnooze = document.getElementById('btn-snooze');
                    const cdDisplay = document.getElementById('ring-countdown');
                    if (btnSnooze) btnSnooze.style.display = 'block';
                    if (cdDisplay) cdDisplay.style.display = 'none';
                }
            }
        });

        document.querySelectorAll('.day-btn').forEach(btn => {
            btn.addEventListener('click', (e) => { e.target.classList.toggle('selected'); });
        });
    },

    persist() {
        localStorage.setItem('timer_alarms', JSON.stringify(this.alarms));
    },

    check() {
        const now = new Date();
        const nowTime = now.getTime();
        const nowStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        const currentDay = now.getDay();
        const todayDate = now.toDateString();
        let changed = false;

        const elapsedSinceLastCheck = nowTime - (this.lastCheck || nowTime);
        this.lastCheck = nowTime;

        this.alarms.forEach(a => {
            if (!a.active) return;
            const days = a.days || [];
            const isDayMatch = (days.length === 0 || days.includes(currentDay));
            if (!isDayMatch) return;

            const [alarmH, alarmM] = a.time24.split(':').map(Number);
            const alarmDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), alarmH, alarmM, 0, 0);
            const alarmTime = alarmDate.getTime();

            const isExactMinute = (a.time24 === nowStr);
            const passedDuringSleep = (alarmTime <= nowTime && alarmTime >= (nowTime - Math.min(elapsedSinceLastCheck + 5000, 15 * 60 * 1000)));

            const triggerKey = `${todayDate}_${a.time24}`;
            if ((isExactMinute || passedDuringSleep) && a.lastTriggeredKey !== triggerKey) {
                a.lastTriggeredKey = triggerKey;
                if (days.length === 0) {
                    a.active = false;
                    changed = true;
                }
                Background.startPersistence();
                AudioMgr.startAlarm(a.soundId, `Alarm (${a.time24})`);
            }
        });

        if (changed) { this.render(); this.persist(); }
        this.updateInfo();
    },

    snooze() {
        AudioMgr.stopSound();
        const btnSnooze = document.getElementById('btn-snooze');
        const cdDisplay = document.getElementById('ring-countdown');
        if (btnSnooze) btnSnooze.style.display = 'none';
        if (cdDisplay) cdDisplay.style.display = 'block';

        this.snoozeTargetTime = Date.now() + (9 * 60 * 1000);
        const update = () => {
            const diff = this.snoozeTargetTime - Date.now();
            if (diff <= 0) {
                clearInterval(this.snoozeInterval);
                this.snoozeTargetTime = null;
                AudioMgr.startAlarm();
                if (btnSnooze) btnSnooze.style.display = 'block';
                if (cdDisplay) cdDisplay.style.display = 'none';
            } else {
                const m = Math.floor(diff / 60000).toString().padStart(2, '0');
                const s = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');
                if (cdDisplay) cdDisplay.textContent = `${m}:${s}`;
            }
        };
        update();
        if (this.snoozeInterval) clearInterval(this.snoozeInterval);
        this.snoozeInterval = setInterval(update, 1000);
    },

    stopRing() {
        AudioMgr.stopAlarm();
        if (this.snoozeInterval) {
            clearInterval(this.snoozeInterval);
            this.snoozeInterval = null;
        }
        this.snoozeTargetTime = null;
        const btnSnooze = document.getElementById('btn-snooze');
        const cdDisplay = document.getElementById('ring-countdown');
        if (btnSnooze) btnSnooze.style.display = 'block';
        if (cdDisplay) cdDisplay.style.display = 'none';
    },

    openPicker(id = null) {
        this.editId = id;
        let h = 12, m = 0, ap = 'AM', days = [], soundName = "Default Beep", soundId = null;
        const delBtn = document.getElementById('modal-delete-btn');

        if (id) {
            const a = this.alarms.find(x => x.id === id);
            if (a) {
                const [H, M] = a.time24.split(':').map(Number);
                ap = H >= 12 ? 'PM' : 'AM';
                h = H % 12 || 12;
                m = M;
                days = a.days || [];
                if (a.soundName) soundName = a.soundName;
                if (a.soundId) soundId = a.soundId;
                if (delBtn) delBtn.style.display = 'block';
            }
        } else {
            const now = new Date(Date.now() + 60000);
            const H = now.getHours();
            ap = H >= 12 ? 'PM' : 'AM';
            h = H % 12 || 12;
            m = now.getMinutes();
            if (delBtn) delBtn.style.display = 'none';
        }

        this.tempSoundId = soundId;
        this.tempSoundName = soundName;
        const nameEl = document.getElementById('current-sound-name');
        if (nameEl) nameEl.textContent = soundName;
        const soundInput = document.getElementById('sound-input');
        if (soundInput) soundInput.value = "";

        document.querySelectorAll('.day-btn').forEach(btn => {
            const d = parseInt(btn.dataset.day);
            if (days.includes(d)) btn.classList.add('selected'); else btn.classList.remove('selected');
        });

        const modal = document.getElementById('modal-time-picker');
        if (modal) modal.style.display = 'flex';

        Picker.set(h, m, ap);
        setTimeout(() => Picker.set(h, m, ap), 50);
        setTimeout(() => Picker.set(h, m, ap), 150);
    },

    handleFileSelect(e) {
        const file = e.target.files[0];
        if (!file) return;
        const id = 'sound_' + Date.now();
        this.tempSoundId = id;
        this.tempSoundName = file.name;
        const nameEl = document.getElementById('current-sound-name');
        if (nameEl) nameEl.textContent = file.name;
        MusicStore.save(id, file);
    },

    closePicker() {
        const modal = document.getElementById('modal-time-picker');
        if (modal) modal.style.display = 'none';
        this.editId = null;
    },

    save() {
        const val = Picker.get();
        if (val && val.h && val.m !== null && val.m !== undefined && val.ap) {
            let H = parseInt(val.h);
            const M = parseInt(val.m);
            if (val.ap === 'PM' && H !== 12) H += 12;
            if (val.ap === 'AM' && H === 12) H = 0;
            const time24 = `${H.toString().padStart(2, '0')}:${M.toString().padStart(2, '0')}`;
            const days = [];
            document.querySelectorAll('.day-btn.selected').forEach(btn => days.push(parseInt(btn.dataset.day)));
            days.sort((a, b) => a - b);
            if (this.editId) {
                const a = this.alarms.find(x => x.id === this.editId);
                if (a) {
                    a.time24 = time24;
                    a.days = days;
                    a.active = true;
                    a.soundId = this.tempSoundId;
                    a.soundName = this.tempSoundName;
                    delete a.lastTriggeredKey;
                }
            } else {
                this.alarms.push({
                    id: Date.now(),
                    time24: time24,
                    active: true,
                    days: days,
                    soundId: this.tempSoundId,
                    soundName: this.tempSoundName
                });
            }
            this.render();
            this.persist();
        }
        this.closePicker();
    },

    delete() {
        if (this.editId) {
            this.alarms = this.alarms.filter(a => a.id !== this.editId);
            this.render();
            this.persist();
            this.closePicker();
        }
    },

    toggle(id, e) {
        if (e) e.stopPropagation();
        const a = this.alarms.find(x => x.id === id);
        if (a) {
            a.active = !a.active;
            if (a.active) {
                delete a.lastTriggeredKey;
            }
            this.render();
            this.persist();
        }
    },

    render() {
        this.alarms.sort((a, b) => a.time24.localeCompare(b.time24));
        if (this.listEl) {
            this.listEl.innerHTML = this.alarms.map(a => {
                const [H, M] = a.time24.split(':').map(Number);
                const ap = H >= 12 ? 'PM' : 'AM';
                const h = H % 12 || 12;
                const m = M.toString().padStart(2, '0');
                let dayStr = "";
                if (a.days && a.days.length > 0) {
                    if (a.days.length === 7) dayStr = "Daily";
                    else if (a.days.length === 2 && a.days.includes(0) && a.days.includes(6)) dayStr = "Weekends";
                    else if (a.days.length === 5 && !a.days.includes(0) && !a.days.includes(6)) dayStr = "Weekdays";
                    else {
                        const map = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                        dayStr = a.days.map(d => map[d]).join(', ');
                    }
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
        }
        this.updateInfo();
    },

    updateInfo() {
        if (!this.infoEl) return;
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
                let diff = alarmMin - nowMin;
                if (diff <= 0) diff += 1440;
                if (diff < minMinutes) minMinutes = diff;
            } else {
                days.forEach(d => {
                    let dayOffset = (d - nowDay + 7) % 7;
                    let diff;
                    if (dayOffset === 0) {
                        diff = alarmMin - nowMin;
                        if (diff <= 0) diff += 10080;
                    } else {
                        diff = (dayOffset * 1440) + (alarmMin - nowMin);
                    }
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
        if (minsLeft > 0 || (daysLeft === 0 && hrsLeft === 0)) {
            txt += `${minsLeft}m`;
        }
        this.infoEl.textContent = txt;
    }
};
